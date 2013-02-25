/**
  Ground Web Framework (c) 2011-2012 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Model Class
  
  This class represents a Model in a MVC architecture.
  The model supports persistent storage, offline operation 
  and automatic client<->server synchronization.
  
  Events:
  
  'deleted:', emitted when a model has been deleted.
  
*/

/// <reference path="base.ts" />
/// <reference path="collection.ts" />
/// <reference path="sequence.ts" />
/// <reference path="overload.ts" />
/// <reference path="storage/queue.ts" />
/// <reference path="sync/sync.ts" />

module Gnd {

export interface IModel 
{
  new (args: {}, bucket: string): Model;
  __bucket: string;
  create(args: {}, keepSynced: bool, cb: (err: Error, instance?: Model) => void): void;
  findById(keyPathOrId, keepSynced?: bool, args?: {}, cb?: (err: Error, instance?: Model) => void);
  all(parent: Model, args: {}, bucket: string, cb:(err: Error, items: Model[]) => void);
  seq(parent: Model, args: {}, bucket: string, cb:(err: Error, items: Model[]) => void);
}

export class Model extends Base implements Sync.ISynchronizable
{
  static  __bucket: string;
  private __bucket: string;
  
  private __rev: number = 0;
  
  private _persisted: bool = false;

  // Dirty could be an array of modified fields
  // that way we can only synchronize whats needed. Furthermore,
  // when receiving a resync event we could check if there is a 
  // conflict or not.
  private _dirty: bool = true;
  
  private _keepSynced: bool = false;
  
  private _cid: string;
  private _id: string;
  
  public _initial: bool = true;
  
  
  static syncManager: Sync.Manager;
  static storageQueue: Storage.Queue;
  
  constructor(args: {}, bucket: string){
    super();
        
    _.extend(this, args);
    
    this._cid = this._id || this._cid || Util.uuid();
    this.__bucket = bucket;
    
    this.on('changed:', () => {
      this._dirty = true;
    });
    
    var listenToResync = () => {
      Model.storageQueue.on('resync:'+Storage.Queue.makeKey(this.getKeyPath()), (doc: {}) => {
        // NOTE: If the model is "dirty", we could have a conflict
        this.set(doc, {nosync: true});
        this.emit('resynced:');
      });
    }
    
    if(Model.storageQueue){
      if(this.isPersisted()){
        listenToResync();
      }else{
        this.once('id', listenToResync);
      }
    }
  }
  
  /**
   *
   *  Subclasses the Model class
   *
   *  @param {String} bucket A string representing a placeholder in the 
   *  storage where to save the model.
   *  @return {IModel} A Model Subclass.
   *
   */
  static extend(bucket: string)
  {
    var _this = this;
    function __(args, _bucket) {
      _this.call(this, args, bucket || _bucket);
    }; 
    
    __.prototype = this.prototype;
    __.prototype._super = this;

    // Copy Models static methods
    _.extend(__, {
      __bucket: bucket,
      extend: this.extend,
      create: this.create,
      findById: this.findById,
      all: this.all,
      seq: this.seq,
      allModels: this.allModels,
      createModels: this.createModels,
      fromJSON: this.fromJSON,
      fromArgs: this.fromArgs
    });
    
    return __;
  }

  static create(args: {}, cb: (err: Error, instance?: Model) => void): void;
  static create(args: {}, keepSynced: bool, cb: (err?: Error, instance?: Model) => void): void;
  static create(args: {}, keepSynced?: bool, cb?: (err?: Error, instance?: Model) => void): void
  {
    overload({
      'Object Boolean Function': function(args, keepSynced, cb){
        this.fromJSON(args, (err, instance) => {
          if(instance){
            keepSynced && instance.keepSynced();
            if(!instance.isPersisted()){
              var id = instance.id();
              Model.storageQueue.once('created:'+id, (id) => {
                instance.id(id);
              });
            }
            instance.init(() => {
              cb(null, instance);
            })
          }else{
            cb(err);
          }
        })
      },
      'Object Function': function(args, cb){
        this.create(args, false, cb);
      }
    }).apply(this, arguments);
  }
  
  static findById(keyPathOrId, keepSynced?: bool, args?: {}, cb?: (err: Error, instance?: Model) => void)
  {
    return overload({
      'Array Boolean Object Function': function(keyPath, keepSynced, args, cb){
        Model.storageQueue.fetch(keyPath, (err?, doc?: {}) => {
          if(doc){
            _.extend(doc, args);
            this.create(doc, keepSynced, cb);
          }else{
            cb(err);
          }
        });
        return this;
      },
      'String Boolean Object Function': function(id, keepSynced, args, cb){
        return this.findById([this.__bucket, id], keepSynced, args, cb);
      },
      'String Function': function(id, cb){
        return this.findById(id, false, {}, cb);
      },
      'String Boolean Function': function(id, keepSynced, cb){
        return this.findById(id, keepSynced, {}, cb);
      },
      'String Object Function': function(id, args, cb){
        return this.findById(id, false,args, cb);
      }  
    }).apply(this, arguments);
  }
  
  /**
    Removes a model from the storage. 
    
    Note: If there are instances of the removed model, they will not be destructed
    by calling this method.
  */
  static removeById(keypathOrId, cb?: (err?: Error) => void){
    var keypath = _.isArray(keypathOrId) ? keypathOrId : [this.__bucket, keypathOrId];

    Model.storageQueue.del(keypath, (err: Error) => {
      cb(err);
    });
  }
  
  static fromJSON(args, cb){
    cb(null, new this(args));
  }
  
  static fromArgs(args, cb){
    this.fromJson(args, cb);
  }
  
  destroy(): void
  {
    Model.syncManager && Model.syncManager.endSync(this);
    super.destroy();
  }
  
  init(fn){
    fn(this)
  }
  
  id(id?: string): string 
  {
    if(id){
      this._id = id;
      this._persisted = true;
      this.emit('id', id);
    }
    return this._id || this._cid;
  }
  
  getName(): string
  {
    return "Model";
  }
  
  getKeyPath(): string[]
  {
    return [this.__bucket, this.id()];
  }
  
  isKeptSynced(): bool
  {
    return this._keepSynced;
  }
  
  isPersisted(): bool
  {
    return this._persisted;// || (this._state >= ModelState.CREATED);
  }
  
  bucket(): string
  {
    return this.__bucket;
  }
  
  save(cb?: (err: Error) => void)
  {
    if(this._dirty){
      this.update(this.toArgs(), cb);
    }
  }
  
  //
  // TODO: Should update be a static method instead? since
  // we can have several instances of the same model it feels more correct.
  //
  /*
      Updates a model (in its storage) with the given args.

      update(args)
  */
  update(args: {}, cb?: (err: Error) => void)
  {
    var
      bucket = this.__bucket,
      id = this.id();
    
    cb = cb || (err?: Error)=>{};
    
    if(this._initial){
      args['_initial'] = this._initial = false;
      Model.storageQueue.once('created:'+id, (id) => {
        this.id(id);
      });
      Model.storageQueue.create([bucket], args, (err?, id?) => {
        // this._cid ? id ?
        cb(err);
      });
    }else{
      Model.storageQueue.put([bucket, id], args, (err)=>{
        if(!err){
          this.emit('updated:', this, args);
        }
        cb(err);
      });
    }
  }

  //
  // TODO: rename to remove
  //
  remove(cb?: (err?: Error) => void)
  {
    cb = cb || (err?: Error)=>{};
    
    Model.removeById(this.getKeyPath(), (err?)=> {
      Model.syncManager && Model.syncManager.endSync(this);
      this.emit('deleted:', this.id());
      cb(err);
    })    
  }
    
  keepSynced()
  {
    if(this._keepSynced) return;
  
    this._keepSynced = true;
    
    var startSync = () => {
      Model.syncManager && Model.syncManager.startSync(this);
    }
  
    if (this.isPersisted()){
      startSync();
    }else{
      this.once('id', startSync);
    }
  
    this.on('changed:', (doc, options) => {
      if(!options || ((!options.nosync) && !_.isEqual(doc, options.doc))){
        this.update(doc);
      }
    });
  }
  
  toArgs(){
    var args = {
      _persisted:this._persisted, 
      _cid:this._cid
    };
    
    for(var key in this){
      if(!_.isUndefined(this[key])  &&  
         !_.isNull(this[key])       &&
         !_.isFunction(this[key])   &&
         (key[0] !== '_')) {
        
        if(_.isFunction(this[key].toArgs)){
          args[key] = this[key].toArgs();
        }else if(!_.isObject(this[key])){
          args[key] = this[key]
        }
      }
    }
    return args
  }
  
  
  static createModels(docs, done){
    var models = [];
    
    Util.asyncForEach(docs, (args, fn)=>{
      this.create(args, function(err, instance?: Model){
        if(instance){
          models.push(instance);
        }
        fn(err);
      });
    }, (err) => {
      done(err, models);
    });
  }
  
  static allModels(cb:(err?: Error, models?: Model[]) => void) {
    Model.storageQueue.find([this.__bucket], {}, {}, (err?, docs?) => {
      if(docs){
        this.createModels(docs, cb);
      }else{
        cb(err);
      }
    });
  }

  /**
    Returns all the instances of collection determined by a parent model and
    the given model class.
    (Should we deprecate this in favor of a keyPath based method?)
  */
  // static all(args: {}//, bucket: string, cb:(err?: Error, items?: Model[]) => void);

  static all(parent: Model, args: {}, bucket: string, cb:(err?: Error, collection?: Collection) => void);
  static all(parent: Model, cb:(err?: Error, collection?: Collection) => void);
  static all(parent?: Model, args?: {}, bucket?: string, cb?:(err?: Error, collection?: Collection) => void){
    function allInstances(parent, keyPath, args, cb){
      Model.storageQueue.find(keyPath, {}, {}, (err?, docs?) => {
        if(docs){
          _.each(docs, function(doc){_.extend(doc, args)});
          Collection.create(this, parent, docs, cb);
        }else{
          cb(err);
        }
      });
    }
    overload({
      'Model Array Object Function': function(parent, keyPath, args, cb){
        allInstances(parent, keyPath, args, cb);
      },
      'Model Object String Function': function(parent, args, bucket, cb){
        var keyPath = parent.getKeyPath();
        keyPath.push(bucket);
        allInstances(parent, keyPath, args, cb);
      },
      'Model Function': function(parent, cb){
        var keyPath = parent.getKeyPath();
        keyPath.push(this.__bucket);
        allInstances(parent, keyPath, {}, cb);
      }
    }).apply(this, arguments);
  }

  public all(model: IModel, args, bucket, cb)
  {
    model.all(this, args, bucket, cb);
  }

  /**
    Returns the sequence determined by a parent model and
    the given model class.
  */
  static seq(parent: Model, args: {}, bucket: string, cb:(err?: Error, sequence?: Sequence) => void);
  static seq(parent: Model, cb:(err?: Error, sequence?: Sequence) => void);
  static seq(parent?: Model, args?: {}, bucket?: string, cb?:(err?: Error, sequence?: Sequence) => void){
    function allInstances(parent, keyPath, args, cb){
      // Model.storageQueue.find(keyPath, {}, {}, (err?, docs?) => {
      // Model.storageQueue.all(keyPath, {}, {}, (err?, docs?) => {
      //   if(docs){
      //     _.each(docs, function(doc){_.extend(doc, args)});
      //     Sequence.create(this, parent, docs, cb);
      //   }else{
      //     cb(err);
      //   }
      Model.storageQueue.all(keyPath, {}, {}, (err, docs?) => {
        if(docs){
          Sequence.create(this, parent, _.pluck(docs, 'doc'), cb);
          // Util.asyncForEach(keyPaths, (keyPath, fn)=>{
          //   Model.storageQueue.fetch(keyPath, (err, doc)=>{

          //     _.extend(doc, args);
          //     docs.push(doc);
          //     fn(err);
          //   });
          // }, (err) => {
          //   Sequence.create(this, parent, docs, cb);
          // });
        }else{
          cb(err);
        }
      });
    }
    overload({
      'Model Array Object Function': function(parent, keyPath, args, cb){
        allInstances(parent, keyPath, args, cb);
      },
      'Model Object String Function': function(parent, args, bucket, cb){
        var keyPath = parent.getKeyPath();
        keyPath.push(bucket);
        allInstances(parent, keyPath, args, cb);
      },
      'Model Function': function(parent, cb){
        var keyPath = parent.getKeyPath();
        keyPath.push(this.__bucket);
        allInstances(parent, keyPath, {}, cb);
      }
    }).apply(this, arguments);
  }

  public seq(model: IModel, args, bucket, cb)
  {
    model.seq(this, args, bucket, cb);
  }
}

}
