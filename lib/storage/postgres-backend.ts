/**
  Ground Web Framework (c) 2013 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Storage implementation using PostgreSQL
  and https://github.com/brianc/node-sql
*/
/// <reference path="storage.ts" />
/// <reference path="../model.ts" />
/// <reference path="../error.ts" />

declare module 'postgres' {
  export interface Schema {
    constructor(def: {});
    //static ObjectId : any;
  }
  export function model (name: string, schema: Schema) : any;
}

declare module "lodash" {
  export function last (array : any[], n? : number) : any;
  export function find (array : any[], iterator: (elem:any)=>boolean) : any;
  export function isEqual (object : any, other : any) : boolean;
  export function isFunction (object : any) : boolean;
  export function initial (array : any[], n? : number) : any[];
}

/**
  @module Gnd
  @submodule Storage
*/
module Gnd.Storage {
 
function makeKey(keyPath: string[]): string {
  return keyPath.join('@');
}
function parseKey(key: string): string[] {
  return key.split('@');
}

export interface GndModel {
  parent?: ()=>string;
 // gnd?: { add: (id: string, name: string, itemIds: string[], cb: (err: Error, ids: string[])=>void)=>void}; 
 add?: any;
}

export interface IMongooseModel extends GndModel {
  new (doc: {}): any;
  update(query:{}, args:{}, cb:(err: Error, num: any)=>void);
  findOneAndUpdate(conditions?:{}, update?:{}, cb?: (err: Error, doc:{}) => void);
  findOneAndUpdate(conditions?:{}, update?:{}, options?:{}, cb?: (err: Error, doc:{}) => void);
  findByIdAndUpdate(id: string, update?:{}, cb?: (err: Error, doc:{}) => void);
  findById(id:string, cb:(err: Error, doc?: any)=>void):any;
  findById(id:string, fields?:string):any;
  find(conditions:{}, fields?: {}, options?: {}, cb?: (err: Error, docs?: any)=>void): any;
  findById(id: string): any;
  remove(query:{}, cb:(err: Error)=>void);
}

interface FoundModel
{
  Model: IMongooseModel;
  id: string;
}

export interface IModels
{
  [indexer: string]: IModel;
}

export interface IMongooseModels
{
  [indexer: string]: IModel;
}

/**
  [PostgreSQL](https://github.com/brianc/node-postgres) implementation of IStorage.

  @class Storage.MongooseStorage
  @extends Storage.IStorage
  @constructor
  @param models {Any} Object mapping model buckets and models.
  @param mongoose {Mongoose} A valid mongoose instance.
*/
export class PostgresStorage implements Storage.IStorage {
  public models: any = {};
  private listContainer: any;
  private transaction: any;
  private postgres;
  private nameMapping;
  
  constructor(postgres, models: IModels, legacy?: IMongooseModels)
  {
    this.listContainer = mongoose.model('ListContainer', new mongoose.Schema({
      type: { type: String },
      next: { type: mongoose.Schema.ObjectId, ref: 'ListContainer' },
      modelId: { type: String }
    }));
    
    this.mongoose = mongoose;
    this.compileModels(models, mongoose, legacy);
  }
  
  addModel(name: string, model: IModel){
    var nameMapping = this.nameMapping = this.nameMapping || {};
    nameMapping[model.__bucket] = name;
    
    this.compileModel(name, model, this.mongoose, nameMapping);
  }
  
  private compileModel(name: string, model: IModel, mongoose, nameMapping){
    var schema = model.schema();
    var bucket = model.__bucket;
    
    if(bucket){
      var translated = this.translateSchema(mongoose, nameMapping, schema);
      var mongooseSchema =
          new mongoose.Schema(translated, {strict: false});
      // new mongoose.Schema(translated); // strict false is just temporary...

      if(model['__mongoose']){
        var extra = model['__mongoose'];

        if(extra.methods){
          mongooseSchema.methods = mongooseSchema.methods || {};
          _.extend(mongooseSchema.methods, extra.methods);
        }
        
        if(extra.statics){
          mongooseSchema.statics = mongooseSchema.statics || {};
          _.extend(mongooseSchema.statics, extra.statics);
        }
                  
        if(extra.pre){
          _.each(extra.pre, function(fn, method){
            mongooseSchema.pre(method, fn);
          })
        }
        if(extra.post){
          _.each(extra.post, function(fn, method){
            mongooseSchema.post(method, fn);
          })
        }
      }
      
      this.models[bucket] =
        mongoose.model(name, mongooseSchema, bucket);
        
      if(model['filter']){
        this.models[bucket]['filter'] = model['filter'];
      }
    }
  }

  /**
    Compiles Gnd models into Mongoose Models.
  */
  private compileModels(models: IModels, mongoose, legacy?)
  { 
    var nameMapping = this.nameMapping = this.nameMapping || {};
    for(var name in models){
      var model = models[name];
      nameMapping[model.__bucket] = name;
    }
    for(var bucket in legacy){
      nameMapping[bucket] = legacy[bucket].modelName;
    }

    for(var name in models){
      this.compileModel(name, models[name], mongoose, nameMapping);
    }
    
    legacy && _.extend(this.models, legacy);
  }

  private translateSchema(mongoose, mapping, schema: Schema): any
  {
    // Translate ObjectId, Sequences and Collections since they have special
    // syntax.
    return schema.map((key, value) => {
      if(key != '_id'){
        var res;
        if(value instanceof Schema){
          return this.translateSchema(mongoose, mapping, value);
        }
        if(value.definition.type){
          res = _.clone(value.definition);
        }else{
          res = {type: value.definition};
        }
        
        if(res.type.__schema){
          return this.translateSchema(mongoose, mapping, res.type.__schema);
        }
        
        switch(res.type){
          case Gnd.Schema.ObjectId:
            res.type = mongoose.Schema.ObjectId;
            break;
          case Gnd.Schema.Abstract:
            break;
          case Gnd.Sequence:
          case Gnd.Collection:
            if(!mapping[res.ref.bucket]){
              throw new Error("Model bucket " + res.ref.bucket + " does not have a valid mapping name");
            }else{
              res = {type: [{type: mongoose.Schema.ObjectId, ref: mapping[res.ref.bucket]}], 
                    select: false};
            }
            break;
        }
        return res;
      }
    });
  }
  
  create(keyPath: string[], doc: any): Promise<string>
  {
    return this.getModel(keyPath).then<string>((found) => {
      var promise = new Promise<string>();
      if(found.Model['filter']){
        found.Model['filter'](doc, (err, doc) =>{
          if(!err){
            create(doc);
          }
        });
      }else{
        create(doc);
      }
      
      function create(doc){
        var instance = new found.Model(doc);
        instance.save(function(err, doc){
          if(!err){
            doc.__rev = 0;
            promise.resolve(doc._id);
          }else{
            promise.reject(err);
          }
        });
      }
      return promise;
    });
  }
  
  put(keyPath: string[], doc: any): Promise<void>
  {
    return this.getModel(keyPath).then<void>(function(found){
      var promise = new Promise<void>();
      if(found.Model['filter']){
        found.Model['filter'](doc, (err, doc) =>{
          if(!err){
            update(doc);
          }
        });
      }else{
        update(doc);
      }
      function update(doc){
        found.Model.findByIdAndUpdate(_.last(keyPath), doc, (err, oldDoc) => {
          if(!err){
            // Note: isEqual should only check the properties present in doc!
            if(!_.isEqual(doc, oldDoc)){
              // only if doc modified synchronize
              // Why is this out commented?
              //this.sync && this.sync.update(keyPath, doc);
              promise.resolve();
            }
          }else{
            promise.reject(err);
          }
        });
      }
      return promise;
    });
  }

  /*
    Cat
    .where('name', 'Sprinkles')
    .findOneAndUpdate({ name: 'Sprinkles' })
    .setOptions({ new: false })
    .exec(function (err, cat) {
      if (err) ..
      render('cat', cat);
      });
  */
  
  fetch(keyPath: string[]): Promise<any>
  {
    return this.getModel(keyPath).then((found) => {
      var promise = new Promise()
      found.Model.findById(_.last(keyPath), (err, doc?) => {
        if(doc){
          promise.resolve(doc);
        }else{
          console.log("Document:", keyPath, "not Found!");
          promise.reject(err || new Error(''+ServerError.DOCUMENT_NOT_FOUND))
        }
      });
      return promise;
    });
  }
  
  del(keyPath: string[]): Promise<void>
  {
    return this.getModel(keyPath).then<void>((found) => {
      var promise = new Promise<void>();
      found.Model.findById(_.last(keyPath), (err?, doc?) => {
        if(!err && doc){
          doc.remove((err?)=>{
            !err && promise.resolve();
            err && promise.reject(err);
          });
        }else{
          promise.reject(err);
        }
      });
      
      //found.Model.findByIdAndRemove({_id:_.last(keyPath)}, (err, doc)=>{
      /*
      found.Model.remove({_id:_.last(keyPath)}, (err?)=>{
        if(!err){
          promise.resolve();
        }else{
          promise.reject(err);
        }
      });
      return promise;
      */
    });
  }
  
  add(keyPath: string[], itemsKeyPath: string[], itemIds:string[], opts:any): Promise<void>
  {    
    return this.getModel(keyPath).then<void>((found) => {
      var promise = new Promise<void>();
      var id = keyPath[keyPath.length-2];
      var setName = _.last(keyPath);
      if(found.Model.add){
        found.Model.add(id, setName, itemIds, (err, ids)=>{
          if(!err){
            // Use FindAndModify to get added items
            // sync.add(id, setName, ids);
            promise.resolve();
          }else{
            promise.reject(err);
          }
        });
      }else{
        var update = {$addToSet: {}};
        update.$addToSet[setName] = {$each:itemIds};
        found.Model.update({_id:id}, update, (err) => {
          if(!err){
            // Use FindAndModify to get added items
            // sync.add(id, setName, ids);
            promise.resolve();
          }else{
            promise.reject(err);
          }
        });
      }      
      /*
      else{
        promise.reject(new Error("No parent or add function available"));
      }
      */
      return promise;
    });
  }

  remove(keyPath: string[], itemsKeyPath: string[], itemIds:string[], opts: any): Promise<void>
  {
    if(itemIds.length === 0) return Promise.resolved(); //nothing to do
    
    return this.getModel(keyPath).then<void>((found) => {
      var promise = new Promise<void>();
      
      var id = keyPath[keyPath.length-2];  
      var setName = _.last(keyPath);
      var update = {$pullAll: {}};
      update.$pullAll[setName] = itemIds;
      found.Model.update({_id:id}, update, function(err){
        // TODO: Use FindAndModify to get removed items
        if(!err){
          promise.resolve();
        }else{
          promise.reject(err);
        }
      });
      return promise;
    });
  }
  
  find(keyPath: string[], query: Storage.IStorageQuery, opts: {}): Promise<any[]>
  {
    return this.getModel(keyPath).then<any[]>((found)=>{
      if(keyPath.length === 1){
        return this.findAll(found.Model, query);
      }else{
        var id = keyPath[keyPath.length-2];
        var setName = _.last(keyPath);
        return this.findById(found.Model, id, setName, query, opts);
      }
    });
  }

  private findAll(Model: IMongooseModel, query: Storage.IStorageQuery): Promise<any[]>
  {
    query = query || {};  
    var promise = new Promise();
    Model
      .find(query.cond, query.fields, query.opts)
      .exec((err, doc?) => {
        if(err){
          promise.reject(err);
        }else{
          promise.resolve(doc);
        }
      });
    
    return promise;
  }

  private findById(Model: IMongooseModel, 
                   id: string, 
                   setName: string,
                   query: Storage.IStorageQuery,
                   opts: {}): Promise<any[]>
  {
    query = query || {};
    var promise = new Promise();
    Model
      .findById(id)
      .select(setName)
      .populate(setName, query.fields, query.cond, query.opts)
      .exec((err, doc) => {
        if(err){
          promise.reject(err);
        }else{
          promise.resolve(doc && doc[setName])
        }
      });
      
    return promise;
  }
  
/*
Sequences
A sequence is represented as a linked list of listContainers. Every listContainer has
a reference to the next listContainer and to the model instance it refers to. A
listContainer may also have a type attribute:
  _begin: dummy container before the first real item in the sequence
  _end: dummy container after the last real item in the sequence
  _rip: 'tombstone' element that has been deleted from the sequence
*/
  private findContainer(ParentModel: IMongooseModel, parentId, name, id, cb:(err: Error, container?)=>void){
    if(!id){
      this.findEndPoints(ParentModel, parentId, name, (err, begin?, end?)=>{
        cb(err, begin);
      });
    }else{
      this.listContainer.find({_id: id}, (err, docs) => {
        if(err) return cb(err);
        if(docs.length !== 1) return cb(Error('container '+id+' not found')); 
        cb(null, docs[0]);
      });
    }
  }

  private findEndPoints(ParentModel: IMongooseModel, parentId, name, cb:(err: Error, begin?, end?)=>void){
    ParentModel.findById(parentId).select(name).exec((err, doc) => {
      if(!doc) return cb(err);
      this.listContainer.find()
        .where('_id').in(doc[name])
        .or([{type:'_begin'}, {type:'_end'}])
        .exec((err, docs)=>{
          if(docs.length < 2) return cb(Error('could not find end points'));
          cb(err,
            _.find(docs, (doc) => {
              return doc.type === '_begin';
            }),
            _.find(docs, (doc) => {
              return doc.type === '_end';
            })
          );
        });
    });
  }

  private removeFromSeq(containerId): Promise
  {
    var promise = new Promise();
    this.listContainer.update(
      {_id: containerId},
      {
        $set: {type: '_rip'}
      },
      (err) => {
        if(err){
          promise.reject(err);
        }else{
          promise.resolve();
        }
      }
    );
    return promise;
  }

  private initSequence(ParentModel: IMongooseModel, parentId, name, cb:(err: Error, begin?, end?)=>void){
    ParentModel.findById(parentId).select(name).exec((err, doc) => {
      if(err) return cb(err);
      if(doc[name].length < 2){
        var first = new this.listContainer({
          type: '_begin'
        });
        first.save((err, first)=>{
          var last = new this.listContainer({
            type: '_end',
          });
          last.save((err, last)=>{
            first.next = last._id;
            first.save((err, first)=>{
              var delta = {};
              delta[name] = [first._id, last._id];
              ParentModel.update(
                {_id: parentId},
                delta,
                (err)=>{
                  cb(null, first, last);
                }
              );
            });
          });
        });
      }else{
        this.findEndPoints(ParentModel, parentId, name, cb);
      }
    });
  }
  // cb: (err:Error, id?: string)=>void)
  private insertContainerBefore(ParentModel:IMongooseModel, parentId, name, nextId, itemKey, opts): Promise
  {
    var promise = new Promise();
    var newContainer = new this.listContainer({
      next: nextId,
      modelId: itemKey
    });
    
    newContainer.save((err, newContainer)=>{
      if(err) return promise.reject(err);

      this.listContainer.update({next: nextId}, {next: newContainer._id}, (err)=>{
        if(err){
          // rollback
          newContainer.remove();
          return promise.reject(err);
        }
        var delta = {};
        delta[name] = newContainer._id;
        ParentModel.update(
          {_id: parentId},
          { $push: delta },
          (err)=>{
            if(err) promise.reject(err);
            else promise.resolve(newContainer._id);
          }
        );
      });
    });
    
    return promise;
  }

  // cb: (err: Error, result?: any[]
  // Note: This code is copy paste of Local.ts (no, its not anymore...)
  all(keyPath: string[], query: {}, opts: {}): Promise<any[]>
  {  
    var all = [];
    var traverse = (kp) => this.next(keyPath, kp, opts).then((next) => {
      if(next){
        all.push(next);
        return traverse(next.id);
      }
    });
    
    return traverse(null).then(() => all);
  }

  private next(keyPath: string[], id: string, opts: {}): Promise<{id: string; refId: string;}>
  {
    var promise = new Promise();
    
    this.getModel(keyPath).then((found) => {
      var ParentModel = found.Model;
      var parentId = keyPath[keyPath.length-2];
      var seqName = _.last(keyPath);

      this.findContainer(ParentModel, parentId, seqName, id, (err, container?)=>{
        if(!id && !container) return promise.resolve(); //empty sequence
        
        this.findContainer(ParentModel, parentId, seqName, container.next, (err, container?)=>{
          if(err) return promise.reject(err);

          if(container.type === '_rip'){ //tombstone
            this.next(keyPath, container._id, opts).then((val) => promise.resolve(val));
          }else if(container.type === '_end'){
            promise.resolve()
          }else{
            var kp = parseKey(container.modelId);
            this.fetch(kp).then((doc)=>{
              promise.resolve({
                id: container._id,
                keyPath: kp,
                doc: doc
              })
            }).fail((err)=>promise.reject(err));
          }
        });
      });
    }).fail((err)=>promise.reject(err));
    
    return promise;
  }

  // id?: string, refId?: string
  insertBefore(keyPath: string[], id: string, itemKeyPath: string[], opts): Promise
  {
    return this.getModel(keyPath).then((found) => {
      var ParentModel = found.Model;
      var modelId = keyPath[keyPath.length-2];
      var seqName = _.last(keyPath);
      var promise = new Promise();
      this.initSequence(ParentModel, modelId, seqName, (err, begin?, end?) => {
        if(!id) id = end._id;
        this.insertContainerBefore(ParentModel, modelId, seqName, id, makeKey(itemKeyPath), opts).then((newId)=>{
          promise.resolve({
            id: newId,
            refId: id === end._id ? null : id
          });
        }).fail((err)=>promise.reject(err));
      });
      return promise;
    });
  }

  deleteItem(keyPath: string[], id: string, opts: {}): Promise<void>
  {
    return this.getModel(keyPath).then<void>((found) => {
      var ParentModel = found.Model;
      var modelId = keyPath[keyPath.length-2];
      var seqName = _.last(keyPath);
      var promise = new Promise();

      this.findContainer(ParentModel, modelId, seqName, id, (err, container?)=>{
        if(!container || container.type === '_rip') return promise.resolve(); //promise.reject(Error(''+ServerError.INVALID_ID));
        this.removeFromSeq(container._id).then(() => promise.resolve(), (err) => promise.reject(err));
      });
      return promise;
    });
  }
  
  private getModel(keyPath: string[]): Promise<FoundModel>
  {
    //
    // ex. /cars/1234/engines/3456/carburetors
    //
    var promise = new Promise();
    var last = keyPath.length - 1;
    var index = last - last & 1;
    var bucket = keyPath[index]; //TODO rename?
    
    if(bucket in this.models){
      promise.resolve({
        Model: this.models[bucket], 
        id: this.models[keyPath[last]]
      });
    }else{
      console.log("Model not found:", keyPath);
      promise.reject(new Error(''+ServerError.MODEL_NOT_FOUND));
    }
    return promise;
  }
  
}

}
