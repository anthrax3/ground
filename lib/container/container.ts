/**
  Ground Web Framework (c) 2011-2013 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Container Class
  
  This class is the base for container classes.
  
*/
/// <reference path="../using.ts" />

/// <reference path="../base.ts" />
/// <reference path="../model.ts" />
/// <reference path="../overload.ts" />
/// <reference path="../storage/local.ts" />
/// <reference path="../storage/store/memory-storage.ts" />

module Gnd 
{
  export interface IContainer<T>
  {
    new (model: IModel, opts?: ContainerOptions, parent?: Model, items?: any[]): any;
  } // We use Any until issue https://typescript.codeplex.com/workitem/1458 is resolved
  
  export interface ContainerOptions
  {
    key?: string;
    nosync?: boolean;
    query?: Storage.IStorageQuery;
  }
  
  /**
   The {{#crossLink "CONTAINER"}}{{/crossLink}} class is used as base class for
   model containers. For example Collection and Sequence are subclasses of
   Container.
   
   The container class also provides the preferred factory method for instantiating 
   Collections and Sequences.
 
    @class Container
    @extends Promise
    @constructor
    @param model {IModel}
    @param [opts] {ContainerOptions}
    @param [parent] {Model}
    @param [items] {Array} array of models
   **/
  export class Container extends Base implements Sync.ISynchronizable
  {
    public storageQueue: Storage.Queue;
  
    // Event Handlers
    public updateFn: (model: Model, args) => void;
    
    public deleteFn: (model: Model) => void;
    
    public resyncFn: (items?: any[]) => void;
    
    /**
      Filtering function to be used for this Container.
      This function defines the filtering function to be used by this container.
  
      @property filterFn
      @type Function
      @default undefined
    **/
    public filterFn: (item: Model) => boolean = null;

    // Prototypes for underscore imported methods.
    public filter: (iterator: (item: any)=>boolean) => Model[];
    
    // --
    
    public _keepSynced: boolean = false;
    
    // Abstract
    public resync(items?: any[]): Promise<any>
    {
      return Promise.resolved(true);
    }
  
    public model: IModel;
    public parent: Model;
    public count: number = 0;
    
    // Protected
    public items: any[];
    public opts: ContainerOptions;
    public _promise: Promise<Container>;
    
    private static getItemIds(items: Model[])
    {
      return _.map(items, (item) => item.id());
    }
    
    /**
      Factory method for container subclasses. If a parent is defined, and
      the parent has autosync enabled, then the container will also be 
      autosynced.
      
      @method create
      @static
      @param ContainerClass {IContainer} Container subclass
      @param model {IModel} Model class
      @param [opts] {ContainerOptions}
      @param [parent] {Model}
      @param [items] {Array}
    */
    static create<T>(
      ContainerClass: IContainer<T>,
      model: IModel, 
      opts?: ContainerOptions,
      parent?: Model, 
      items?: any[]): T
    {
      return new ContainerClass(model, opts, parent, items);
    }
    
    constructor(model: IModel, opts?: ContainerOptions, parent?: Model, items?: any[])
    {
      super();
      
      this.opts = opts = opts || {};
      
      opts.key = opts.key || (model && model.__bucket);
      
      this.storageQueue = 
        new Gnd.Storage.Queue(using.memStorage, using.storageQueue, false);

      this.items = items ? _.clone(items) : [];
      
      this.model = model;
      this.parent = parent;

      this.resyncFn = (items?) => this.resync(items);
      
      parent && parent.isAutosync() && this.autosync(true);
    }
    
    // protected
    _init(updateFn?, deleteFn?){
      this.updateFn = updateFn || this.updateFn;
      this.deleteFn = deleteFn || this.deleteFn;
      
      if(this.items){
        this.initItems(this.getItems());
        this.set('count', this.items.length);
      }
    }
    
    destroy()
    {      
      var keyPath = this.getKeyPath();
      if(keyPath){
        var key = Storage.Queue.makeKey(keyPath);
        this.storageQueue.off('resync:'+key, this.resyncFn);
      }
      
      this._keepSynced && this.endSync();
      this.deinitItems(this.getItems());
      super.destroy();
    }
    
    init(docs: {}[]): Promise<any>
    {
      return this.resync(docs).then(() => this);
    }
    
    /**
      Saves this container to the storages manually.
      
      @method save
      @return {Promise}
    */
    save(): Promise<any>
    {
      return this.storageQueue.exec();
    }
    
    /**
      Gets the keypath for this container.
      
      @method getKeyPath
      @returns {String[]}
    */
    getKeyPath(): string[]
    {
      if(this.opts.key){
        if(this.parent) return [this.parent.bucket(), this.parent.id(), this.opts.key];
        return [this.opts.key];
      }
    }

    /**
    
      Enables autosync for this container, meaning that the container will
      be kept synchronized with its server side counterpart.
    
      @method keepSynced
      @chainable
    */
    keepSynced(): Container
    {  
      this.startSync();

      this['map']((item) => {
        item.keepSynced()
      });
      return this;
    }

    /**
      Checks if this container is kept automatically synced with the 
      storages.

      @method isKeptSynced
      @return {Boolean}
      @deprecated Use autosync instead.
    */
    isKeptSynced(): boolean
    {
      return this._keepSynced;
    }
    
    /**
      Checks if this container is kept automatically synced with the 
      storages.
  
      @method autosync
      @returns {Boolean}
    */
    autosync(): boolean;
    
    /**
      Enables / Disables autosync.
      
      @method autosync
      @param enable {Boolean}
      
      Note: Disable not yet implemented.
    */
    autosync(enable: boolean): void
    autosync(enable?: boolean)
    {
      if(!_.isUndefined(enable)){
        enable && this.keepSynced();
      }else{
        return this._keepSynced;
      }
    }
    
    /**
      @method filtered
      @deprecated
    */
    filtered(cb?: (err: Error, models?: Model[])=>void): any[]
    {
      var result = this.filterFn ? this.filter(this.filterFn) : this.getItems();

      cb && cb(null, result);
      return result;
    }
  
    /**
      Checks if this container if filtered by some filter function.
    
      @method isFiltered
      @return {Boolean}
    */
    isFiltered(item: Model): boolean
    {
      return this.filterFn ? this.filterFn(item) : true;
    } 
    
    // protected
    public startSync()
    {
      this._keepSynced = true;
    
      // TODO: Add support for auto-sync for collections without parents.
      if(this.parent && using.syncManager){
        using.syncManager.observe(this);
      }
    
      this.storageQueue.exec().then(()=>{
        this.storageQueue = using.storageQueue;
      });
    }
    
    // protected
    public endSync()
    {
      using.syncManager && using.syncManager.unobserve(this);
      this._keepSynced = false;
    }
    
    public getItems(): Model[]
    {
      return this.items;
    }
    
    public initItems(item: Model);
    public initItems(items: Model[]);
    public initItems(items)
    {
      items = _.isArray(items)? items:[items];
      for (var i=0,len=items.length; i<len;i++){
        var item = items[i];
        item.retain();
        item.on('changed:', this.updateFn);
        item.on('deleted:', this.deleteFn);
      }
    }
  
    public deinitItems(item: Model);
    public deinitItems(items: Model[]);
    public deinitItems(items)
    {
      items = _.isArray(items)? items:[items];
      for (var i=0,len=items.length; i<len;i++){
        var item = items[i];
        item.off('changed:', this.updateFn);
        item.off('deleted:', this.deleteFn);
        item.release();
      }
    }
    
    //
    // Promise Mixin
    //
    /**
  
      Then method waits for a promise to resolve or reject, and returns a new
      promise that resolves directly if the onFulfilled callback returns a value,
      or if the onFulfilled callback returns a promise then when 
      the returned promise resolves.
  
      @method then
      @param [onFulfilled] {Function}
      @param [onRejected] {Function}
      @return {Promise} A promise according to the rules specified 
    **/
    then<U>(onFulfilled: (value: Container) => U, onRejected?: (reason: Error) => void): Promise<U>;
    then<U>(onFulfilled: (value: Container) => Promise<U>, onRejected?: (reason: Error) => void): Promise<U>;
    then(onFulfilled: (value: Container) => void, onRejected?: (reason: Error) => void): Promise<void>;
    then(onFulfilled: (value: Container) => any, onRejected?: (reason: Error) => void): Promise<any>
    {
      return this._promise.then.apply(this._promise, arguments);
    }
  
    /**
      This method is syntactic sugar for then when only caring about a promise
      rejection.
    
      @method fail
      @param onRejected {Function}
    **/
    fail<U>(onRejected?: (reason: Error) => any): Promise<U>
    {
      return this._promise.fail.apply(this._promise, arguments);
    }
  
    /**
      Ensures that the callback is called when the promise resolves or rejects.
    
      @method ensure
      @param always {Function} callback to be executed always independetly if the 
      project was resolved or rejected.
    **/
    ensure(always: () => any)
    {
      return this._promise.ensure.apply(this._promise, arguments);
    }

    /**
      Cancels the promise (rejects with reason CancelError)
    
      @chainable
    **/
    cancel()
    {
      return this._promise.cancel.apply(this._promise, arguments);
    }
  }
}

