/**
  Ground Web Framework (c) 2011-2013 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Collection Class
  
  This class represents a unordered collection of models.
  The collection supports persistent storage, offline and
  automatic client<->server synchronization.
*/
/// <reference path="container.ts" />
/// <reference path="../base.ts" />
/// <reference path="../model.ts" />
/// <reference path="../overload.ts" />
/// <reference path="../mutex.ts" />

module Gnd {
   
export interface CollectionEvents
{
  on(evt: string, ...args: any[]);
  
  /**
  * Fired when any model in the collection changes any property.
  *
  * @event updated:
  * @param item {Model}
  * @param args {any}
  */
  on(evt: 'updated:', item: Model, args:any);
  
  /**
  * Fired when the sortFn property changes and the collection has been resorted.
  *
  * @event sorted:
  * @param items {Model[]}
  * @param oldItems {Model[]}
  */
  on(evt: 'sorted:', items: Model[], oldItems: Model[]);
  
  /**
  * Fired when a model has been added to the collection.
  *
  * @event added:
  * @param item {Model}
  */
  on(evt: 'added:', item: Model);
  
  /**
  * Fired when a model has been removed from the collection.
  *
  * @event removed:
  * @param item {Model}
  */
  on(evt: 'removed:', item: Model);
  
  /**
  * Fired when the collection has been resynced.
  *
  * @event resynced:
  */
  on(evt: 'resynced:');
}

/**
  Collection Schema Type. This class can be used to define collection types
  in schemas.
    
      var ChatSchema = new Schema({
          rooms: new ColectionSchemaType(Room, 'rooms');
      });

  @class CollectionSchemaType
  @extends SchemaType
  @constructor
  @param mode {IModel} A model class defining the type of items to store in the
  sequence.
  @param bucket {String} Bucket where the items are stored in the server.
*/
export class CollectionSchemaType extends SchemaType
{
  public static type = Collection;
  
  constructor(model: IModel, bucket?: string)
  {
    super({type: Collection, ref:{model: model, bucket: bucket || model.__bucket}});
  }
  
  toObject(obj)
  {
    // undefined since a collection is never serialized.
  }
  
  fromObject(arg)
  {
    // undefined since a collection is never deserialized
  }

  get(model, args?, opts?)
  {
    var def = this.definition;
    return model.all(def.ref.model, args || {}, def.ref.bucket);
  }
}

/**
 The {{#crossLink "Collection"}}{{/crossLink}} class is used to represent an
 unsorted set of models (although they can be sorted client side specifying a 
 sorting function).
 
 Collections can be orphan if they are not part of any model, or as more often
 being a property of a model instance.
 
 Collections are normally instantiated lazily, meaning that the collection instance
 is created and afterwards the data is fetched asynchronously. The collection
 can be used before the data has arrived, and as long as the code using the
 collection is reactive (based on the events generated by the collection) 
 everything will work as expected.
 
 Collections inherit the following methods from [Underscore / Lodash](http://http://underscorejs.org/#collections)

      forEach, each, map, reduce, reduceRight, find, detect, pluck,
      filter, select, reject, every, all, some, any, include,
      contains, invoke, max, min, sortBy, sortedIndex, toArray, size,
      first, rest, last, without, indexOf, lastIndexOf, isEmpty, groupBy
 
 
  @class Collection
  @extends Container
  @constructor
  @param model {IModel}
  @param [opts] {ContainerOptions}
  @param [parent] {Model}
  @param [items] {Model[]}
 **/
export class Collection extends Container implements CollectionEvents
{
  // Even handlers
  public updateFn: (model: Model, args) => void;
  public deleteFn: (model: Model) => void;
  
  // Mutex
  private resyncMutex = Mutex();
  
  // Links
  private linkAddFn: (item: Model) => void;
  private linkRemoveFn: (item: Model) => void;
  private linkUpdateFn: (item: Model, fields?: string[]) => void;
  private linkTarget: Collection;
  
  /**
    Sorting function to be used for this Collection.
  
    @property sortByFn
    @type Function
    @default undefined
  **/
  public sortByFn: () => number; //public sortByFn: string;
  
  /**
    Sorting order to be used when specifying a sort function.
  
    @property sortOrder
    @type string
    @default 'asc'
  **/
  public sortOrder: string = 'asc';
  
  constructor(model: IModel, opts?: ContainerOptions, parent?: Model, items?: Model[])
  {
    super(model, opts, parent, items);
    
    var _this = this;
    this.updateFn = function(args){
      if(_this.sortByFn){
        var index = _this['indexOf'](this);
        _this.items.splice(index, 1);
        _this.sortedAdd(<Model>this);
      }
      _this.emit('updated:', this, args);
    };
    
    this.deleteFn = (model)=>{
      this.remove(model.id(), false);
    };

    this.on('sortByFn sortOrder', (fn) => {
      var oldItems = this.items;
      if(this.sortByFn){
        this.items = this['sortBy'](this.sortByFn)
      }
      (this.sortOrder == 'desc') && this.items.reverse();
      this.emit('sorted:', this.items, oldItems);
    });
    
    this.initItems(this.items);
    
    if(parent && parent.isKeptSynced()){
      this.keepSynced()
    }
    
    var keyPath = this.getKeyPath();
    if(keyPath && !this.opts.nosync){
      var useRemote = !parent || parent.isPersisted();
      this.retain();
      using.storageQueue.find(keyPath, opts.query, {noremote: !useRemote}).then((result) => {
        this.resync(result[0]);
        result[1]
          .then((items) => this.resync(items))
          .ensure(() => {
            this.resolve(this);
            this.release();
          })
      });
    }else{
      this.resolve(this);
    }
  }
  
  destroy(){
    this.unlink();
    super.destroy();
  }
  
  /**
    Finds a model in the collection by its Id.
  
    @method findById
    @param id {String} id of the item to find.
    @returns an item if found or undefined otherwise.
  */
  findById(id: string): Model
  {
    return this['find']((item) => item.id() == id);
  }
  
  /**
    Adds items to this collection.
  
    @method add
    @param items {Model[]}
    @param [opts] {Object} 
    
    // TODO: define add options.
  */
  add(item: Model, opts?): Promise
  add(items: Model[], opts?): Promise
  add(items: any, opts?): Promise
  {
    return Promise.map(items, (item) =>
      this.addItem(item, opts).then(() => 
        this._keepSynced && !item._keepSynced && item.keepSynced()));
  }

  /**
    Remove items from this collection based on its ids.
  
    @method remove
    @param itemIds {String[]} item ids to remove.
    @param [opts] {Object}
  */
  remove(itemId: string, opts?): Promise;
  remove(itemIds: string[], opts?): Promise
  remove(itemIds: any, opts?): Promise
  {
    var 
      items = this.items,
      keyPath = this.getKeyPath();

    return Promise.map(itemIds, (itemId) => {
      var item = this.findById(itemId);
  
      if(item){
        items.splice(_.indexOf(items, item), 1);
        
        item.off('changed:', this.updateFn);
        item.off('deleted:', this.deleteFn);
        
        this.set('count', items.length);
        this.emit('removed:', item);
        
        opts = Util.extendClone(this.opts, opts);
        
        item.autorelease();
        
        if((!opts || !opts.nosync) && keyPath){
          var itemKeyPath = _.initial(item.getKeyPath());
          var ids = {}
          ids[item.cid()] = false; // order is important here!
          ids[item.id()] = true;
          return this.storageQueue.remove(keyPath, itemKeyPath, ids, opts);
        }
      }
      return new Promise(true);
    });
  }
  
  /**
    Toggles the sort order from ascending to descending or viceversa.
    
    @method toggleSortOrder
  **/
  toggleSortOrder(){
    this['set']('sortOrder', this.sortOrder == 'asc' ? 'desc' : 'asc');
  }
  
  /**
    Links the collection to target one, listening to added, removed and
    updated event. Besides that, when link is called the first time, it
    generated added events for all the items in the target collection.
    
    Note: a collection can only link to one target collection, although
    many collections can link to the same target.
    
    @method link
    @param target {Collection}
    @param callback {Function}
  */
  link(target: Collection, 
       fn: (evt: string, item: Model, fields?: string[]) => void)
  {
    if(this.linkTarget){
      this.unlink();
    }
    
    this.linkAddFn = (item: Model)=>{
      fn('added:', item);
    };
    this.linkRemoveFn = (item)=>{
      fn('removed:', item);
    };
    this.linkUpdateFn = (item, fields?)=>{
      fn('updated:', item, fields);
    }
    
    // TODO: Add a proxy in EventEmitter class.
    this.linkTarget = target;
    
    target
      .on('added:', this.linkAddFn)
      .on('removed:', this.linkRemoveFn)
      .on('updated:', this.linkUpdateFn);

    target['each'](this.linkAddFn);
  }
  
  /**
    Unlinks the collection (if it was linked, otherwise does nothing)
    
    @method unlink
  */
  unlink()
  {
    if(this.linkTarget){
      this.linkTarget.off('added:', this.linkAddFn);
      this.linkTarget.off('removed:', this.linkRemoveFn);
      this.linkTarget.off('updated:', this.linkUpdateFn);
    }
    
    this.linkAddFn = this.linkRemoveFn = this.linkUpdateFn = null;
  }
  
  private addPersistedItem(item: Model): Promise<void>
  {
    var keyPath = this.getKeyPath();
    if(keyPath){
      var itemKeyPath = _.initial(item.getKeyPath());
    
      return this.storageQueue.add(keyPath, itemKeyPath, [item.id()], {})
    }else{
      return Promise.resolved<void>();
    }
  }

  private addItem(item: Model, opts): Promise<void>
  {
    if(this.findById(item.id())) return new Promise().resolve();
    
    if(this.sortByFn){
      this.sortedAdd(item);
    }else {
      this.items.push(item);
    }

    this.initItems(item);
    
    this.set('count', this.items.length);
    this.emit('added:', item);
    
    opts = Util.extendClone(this.opts, opts);
    
    if(!opts || (opts.nosync !== true)){
      if(item.isPersisted() || item._persisting){
        return this.addPersistedItem(item);
      }else{
        return item.save().then<void>(() => this.addPersistedItem(item));
      }
    }
    return Promise.resolved<void>();
  }
  
  // This function feel a bit hacky
  private sortedAdd(item: Model): number
  {    
    (this.sortOrder == 'desc') && this.items.reverse();
    var i = this['sortedIndex'](item, this.sortByFn);
    this.items.splice(i, 0, item);
    (this.sortOrder == 'desc') && this.items.reverse();
    return i;
  }
  
  /**
    Starts a synchronization procedure. This function is used internally
    for synchronizing remote and local collection data.
    
    @protected
  **/  
  public startSync()
  {
    super.startSync();
    
    this.on('add:', (itemsKeyPath, itemIds) => {
      Promise.map(itemIds, (itemId: string)=>{
        if(!this.findById(itemId)){
          return this.model.findById(itemsKeyPath.concat(itemId), true, {}).then((item)=>{
            item.release();
            return this.addItem(item, {nosync: true});
          });
        }
        return new Promise(true);
      });
    });

    this.on('remove:', (itemsKeyPath, itemId) => {
      this.remove(itemId, {nosync: true});
    });
  }

  /**
    Resync the given items to this collection
  
    @method resync
    @param items {Array} array of items to synchronize the collection with.
    @protected
  **/
  public resync(items: any[]): Promise
  {
    return this.resyncMutex(()=>{
      var 
        itemsToRemove = [],
        itemsToAdd = [];
      
      this['each'](function(item){
        var id = item.id(), shouldRemove = true;
        for(var i=0; i<items.length; i++){
          if(id == items[i]._id){
            item.resync(items[i]);
            shouldRemove = false;
            break;
          }
        }
        shouldRemove && itemsToRemove.push(id);
      });
    
      _.each(items, (item) => {
        if(!this.findById(item._id)) itemsToAdd.push(item);
      })
    
      return this.remove(itemsToRemove, {nosync: true})
        .then(() => _.map(
          _.unique(itemsToAdd), 
          (args) => (<any>this.model).create(args, this.autosync()).autorelease()))
        .then((models: Model[]) => this.add(models, {nosync: true}))
        .then(() =>{
          // We must not return this here!.
          this.emit('resynced:');
        });
    });
  }
}

//
// Underscore methods that we want to implement on the Collection.
//
var methods = 
  ['forEach', 'each', 'map', 'reduce', 'reduceRight', 'find', 'findWhere', 
   'detect', 'pluck','filter', 'select', 'reject', 'every', 'all', 'some',
   'any', 'include','contains', 'invoke', 'max', 'min', 'sortBy', 'sortedIndex',
   'toArray', 'size', 'first', 'rest', 'last', 'without', 'indexOf', 
   'lastIndexOf', 'isEmpty', 'groupBy']

// Mix in each Underscore method as a proxy to `Collection#items`.
_.each(methods, function(method) {
  Collection.prototype[method] = function() {
    return _[method].apply(_, [this.items].concat(_.toArray(arguments)))
  }
});

}
