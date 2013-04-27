/**
  Ground Web Framework (c) 2012 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Ground Server. Acts as a controller for Storage implementations and
  the synchronization module.
*/

/// <reference path="storage/storage.ts" />
/// <reference path="sync/sync-backend.ts" />
/// <reference path="session/rightsmanager.ts" />
/// <reference path="session/sessionmanager.ts" />

/*
  GndServer gndServer = new GndServer(new MongoStorage(...));
*/

// TODO: Improve error handling after ACL rights setting.
module Gnd {

export class Server {
  public storage: IStorage;
  
  private syncHub: Sync.Hub;
  private rm: RightsManager;
  public sessionManager: SessionManager;

  constructor(persistentStorage: IStorage, 
              sessionManager?: SessionManager,
              syncHub?: Sync.Hub,
              rightsManager?: RightsManager)
  {
    this.storage = persistentStorage;
    this.sessionManager = sessionManager;
    this.syncHub = syncHub;
    this.rm = rightsManager || new RightsManager();
  }
  
  create(userId: string, keyPath: string[], doc: any): Promise
  {
    return this.rm.checkRights(userId, keyPath, Rights.CREATE).then((allowed) => {
      if(allowed){
        return this.storage.create(keyPath, doc).then((id) => {
          var newKeyPath = id ? keyPath.concat([id]) : keyPath;
          return this.rm.create(userId, newKeyPath, doc).then(()=>{
            return id;
          }).fail((err)=>{
            // TODO: remove doc
          });
        });
      }
    });
  }
  
  put(clientId: string, userId: string, keyPath: string[], doc: any): Promise
  {
    return this.rm.checkRights(userId, keyPath, Rights.PUT).then((allowed) => {
      if(allowed){
        return this.rm.put(userId, keyPath, doc).then(() => {
          return this.storage.put(keyPath, doc).then(()=>{
            this.syncHub && this.syncHub.update(clientId, keyPath, doc);
          }).fail((err)=>{
            // TODO: remove rights
            console.log("Error updating document:"+keyPath+":"+err)
          });
        });
      }
    });
  }
  
  fetch(userId: string, keyPath: string[]): Promise
  {
    return this.rm.checkRights(userId, keyPath, Rights.GET).then((allowed) => {
      if(allowed){
        return this.storage.fetch(keyPath);
      }
    });
  }

  del(clientId: string, userId: string, keyPath: string[]): Promise
  {
    return this.rm.checkRights(userId, keyPath, Rights.DEL).then((allowed) => {
      if(allowed){
        return this.rm.del(userId, keyPath).then(() => {
          return this.storage.del(keyPath).then(()=>{
            this.syncHub && this.syncHub.delete(clientId, keyPath);
          });
        });
      }
    });
  }

  //
  // Collection
  //
  add(clientId: string, 
      userId: string, 
      keyPath: string[], 
      itemsKeyPath: string[], 
      itemIds:string[], 
      opts: {}, 
      cb: (err?: Error) => void): void
  {
    this.rm.checkRights(userId, keyPath, Rights.PUT).then((allowed) => {
      if(allowed){
        return this.rm.add(userId, keyPath, itemsKeyPath, itemIds).then(() => {
          this.storage.add(keyPath, itemsKeyPath, itemIds, opts, (err?: Error) => {
            if(!err){
              this.syncHub && this.syncHub.add(clientId, keyPath, itemsKeyPath, itemIds);
            }
            cb(err);
          });
        }).fail(cb);
      }else{
        cb();
      }
    }).fail(cb);
  }

  remove(clientId: string, userId: string, keyPath: string[], itemsKeyPath: string[], itemIds:string[], opts: {}, cb: (err?: Error) => void): void
  {
    this.rm.checkRights(userId, keyPath, Rights.DEL).then((allowed) => {
      if(allowed){
        this.rm.remove(userId, keyPath, itemsKeyPath, itemIds).then(() => {
          this.storage.remove(keyPath, itemsKeyPath, itemIds, opts, (err?: Error) => {
            if(!err){
              this.syncHub && this.syncHub.remove(clientId, keyPath, itemsKeyPath, itemIds);
            }
            cb(err);
          });
        }).fail(cb);
      }else{
        cb();
      }
    }).fail(cb);
  }

  find(userId: string, keyPath: string[], query: {}, options: {}, cb: (err: Error, result?: any[]) => void): void
  {
    this.rm.checkRights(userId, keyPath, Rights.GET).then((allowed?) => {
      if(allowed){
        this.storage.find(keyPath, query, options, cb);
      }
    }).fail(cb);
  }
  
  //
  // Sequences
  //
  all(userId: string, keyPath: string[], query: {}, opts: {}, cb: (err?: Error, result?: IDoc[]) => void) : void
  {
    this.rm.checkRights(userId, keyPath, Rights.GET).then((allowed?) => {
      if(allowed){
        this.storage.all(keyPath, query, opts, cb);
      }
    }).fail(cb);
  }
  
  next(userId: string, keyPath: string[], id: string, opts: {}, cb: (err: Error, doc?:IDoc) => void)
  {
    this.rm.checkRights(userId, keyPath, Rights.GET).then((allowed?) => {
      if(allowed){
        this.storage.next(keyPath, id, opts, cb);
      }
    }).fail(cb);
  }

  deleteItem(clientId: string, userId: string, keyPath: string[], id: string, opts: {}, cb: (err?: Error) => void)
  {
    this.rm.checkRights(userId, keyPath, Rights.DEL).then((allowed?) => {
      if(allowed){
        this.storage.deleteItem(keyPath, id, opts, (err?: Error) => {
          if(!err){
            this.syncHub && this.syncHub.deleteItem(clientId, keyPath, id);
          }
          cb(err);
        });
      }
    }).fail(cb);
  }

  insertBefore(clientId: string, userId: string, keyPath: string[], id: string, itemKeyPath: string[], opts, cb: (err: Error, id?: string, refId?: string) => void)
  {
    this.rm.checkRights(userId, keyPath, Rights.PUT).then((allowed) => {
      if(allowed){
        this.storage.insertBefore(keyPath, id, itemKeyPath, opts, (err: Error, id?: string, refId?: string) => {
          if(!err){
            this.syncHub && this.syncHub.insertBefore(clientId, keyPath, id, itemKeyPath, refId);
          }
          cb(err, id);
        });
      }
    }).fail(cb);
  }  
}

}
