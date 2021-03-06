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
  on(evt: string, listener: (...args: any[]) => void): Base;

  /**
  * Fired when any model in the collection changes any property.
  *
  * @event updated:
  * @param item {Model}
  * @param args {any}
  */
  on(evt: 'updated:', listener: (item: Model, args:any) => void): Base;

  /**
  * Fired when the sortFn property changes and the collection has been resorted.
  *
  * @event sorted:
  * @param items {Model[]}
  * @param oldItems {Model[]}
  */
  on(evt: 'sorted:', listener: (items: Model[], oldItems: Model[]) => void): Base;

  /**
  * Fired when a model has been added to the collection.
  *
  * @event added:
  * @param item {Model}
  */
  on(evt: 'added:', listener: (item: Model) => void): Base;

  /**
  * Fired when a model has been removed from the collection.
  *
  * @event removed:
  * @param item {Model}
  */
  on(evt: 'removed:', listener: (item: Model) => void): Base;

  /**
  * Fired when the collection has been resynced.
  *
  * @event resynced:
  */
  on(evt: 'resynced:', listener: () => void): Base;
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

    var __this = this;

    var updateFn = function(args){
      if(__this.sortByFn){
        var index = __this['indexOf'](this);
        __this.items.splice(index, 1);
        __this.sortedAdd(<Model>this);
      }
      __this.emit('updated:', this, args);
    };

    var deleteFn = (model)=>{
      this.remove(model.id(), {nosync: true});
    };

    this._init(updateFn, deleteFn);

    this.on('sortByFn sortOrder', () => {
      if(this.sortByFn){
        var oldItems = this.items;
        this.items = this['sortBy'](this.sortByFn);
        (this.sortOrder == 'desc') && this.items.reverse();
        this.emit('sorted:', this.items, oldItems);
      }
    });

    this._promise = new Promise((resolve, reject) => {
      var keyPath = this.getKeyPath();
      if(keyPath && !this.opts.nosync){
        this.retain();
        // This logic is smelly. There should always try to get from remote or
        // not doing anything at all, not a halfways (only local)
        var noremote = parent && !parent._persisting ? true : false;
        using.storageQueue.find(keyPath, this.opts.query, {noremote:noremote}).then((result) => {
          this.resync(result[0]);
          return result[1];
        })
        .then((items) => this.resync(items))
        .ensure(() => {
          resolve(this);
          this.release();
        });
      }else{
        resolve(this);
      }
    });
    this._promise.uncancellable = true;
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
    return this['find']((item) => item.checkId(id));
  }

  /**
    Adds items to this collection.

    @method add
    @param items {Model[]}
    @param [opts] {Object}

    // TODO: define add options.
  */
  add(item: Model, opts?): Promise<any>
  add(items: Model[], opts?): Promise<any>
  add(items: any, opts?): Promise<any>
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
  remove(itemId: string, opts?): Promise<any>;
  remove(itemIds: string[], opts?): Promise<any>;
  remove(itemIds: any, opts?): Promise<any>
  {
    var
      items = this.items,
      keyPath = this.getKeyPath();

    return Promise.map<any>(itemIds, (itemId) => {
      var item = this.findById(itemId);

      if(item){
        items.splice(_.indexOf(items, item), 1);

        item.off('changed:', this.updateFn);
        item.off('deleted:', this.deleteFn);

        this.set('count', items.length);
        this.emit('removed:', item);

        opts = Util.extendClone(this.opts, opts);

        item.autorelease();

        if(keyPath){
          var itemKeyPath = _.initial(item.getKeyPath());
          var ids = {}
          ids[item.id()] = true;
          if(!opts || !opts.nosync){
            return this.storageQueue.remove(keyPath, itemKeyPath, ids, opts);
          }else{
            return this.storageQueue.removeLocal(keyPath, itemKeyPath, ids, opts).fail((err)=>{
              console.warn(err);
            });
          }
        }
      }
      return Promise.resolved();
    });
  }

  /**
    Remove all the items from this collection (based on what the collection
    has locally). This method should mostly only be used with local collections.

    @method removeAll
    @param [opts] {Object}
  */
  removeAll(opts?){
    var ids = this['map']((item) => {
      return item.id();
    });
    this.remove(ids, opts);
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
    if(this.findById(item.id())){
      Promise.resolved();
    } 

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
        // We do not need to then here...
        return item.save().then<void>(() => this.addPersistedItem(item));
      }
    }
    return Promise.resolved<void>();
  }

  // This function feel a bit hacky
  private sortedAdd(item: Model): number
  {
    (this.sortOrder === 'desc') && this.items.reverse();
    var i = this['sortedIndex'](item, this.sortByFn);
    this.items.splice(i, 0, item);
    (this.sortOrder === 'desc') && this.items.reverse();
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
            item.autorelease();
            return this.addItem(item, {nosync: true});
          });
        }
        return Promise.resolved(true);
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
  public resync(items?: any[]): Promise<any>
  {
    return this.resyncMutex(()=>{
      if(items){
        return this._resync(items);
      }else{
        // Resync called without items assumes this collection is persisted
        this.retain();
        return using.storageQueue.findRemote(this.getKeyPath(), this.opts.query, {})
          .then((items) => this._resync(<any>items)).ensure(()=>this.release());
      }
    });
  }

  private _resync(items: any[]): Promise<any>
  {
    var
      itemsToRemove = [],
      itemsToAdd = [];

    this['each'](function(item){
      var id = item.id(), shouldRemove = true;
      for(var i=0; i<items.length; i++){
        if(items[i] && id == items[i]._cid){
          item.resync(items[i]);
          shouldRemove = false;
          break;
        }
      }
      shouldRemove && itemsToRemove.push(id);
    });

    _.each(items, (item) => {
      if(item && !this.findById(item._cid)){
        itemsToAdd.push(item);
      } 
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
