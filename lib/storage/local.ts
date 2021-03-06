/**
  Ground Web Framework (c) 2012 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Storage implementation using HTML5 LocalStorage
*/

/// <reference path="storage.ts" />
/// <reference path="../cache.ts" />
/// <reference path="../error.ts" />
/// <reference path="../log.ts" />
/// <reference path="store/store.ts" />
/// <reference path="store/local-storage.ts" />

interface KeyValue {
  key: string;
  value: any;
}

/**
@module Gnd
@submodule Storage
*/
module Gnd.Storage {

var InvalidKeyError = () => Error('Invalid Key');

/**
  Generic Storage implementation for local storages.

  Provide an implementation of the IStore interface to create local storages,
  a Memory and HTML5 LocalStorage stores are provided by the framework.

  @class Storage.Local
  @extends IStorage

  @constructor
  @param [store=Storage.Store.LocalStore] specifies what store to use. Defaults
  to LocalStorage.
*/
export class Local implements IStorage {
  private store: Store.IStore;

  private contextualizeIds(keyPath: string[], itemIds:string[]): string[] {
    var baseItemPath = this.makeKey(keyPath);
    return _.map(itemIds, (id)=>{
      return this.makeKey([baseItemPath, id]);
    })
  }

  private makeKey(keyPath: string[]): string {
    return keyPath.join('@');
  }

  private parseKey(key: string): string[] {
    return key.split('@');
  }

  private isLink(doc): boolean {
    return _.isString(doc);
  }

  private isCollectionLink(doc): boolean {
    return doc[0] === '/' && doc[doc.length-1] === '/';

  }
  private createCollectionLink(collection): void {
    var link = '/^' + collection + '@[^@]+$/';
    this.store.put(collection, link);
  }

  private traverseLinks(key: string, fn?: (key:string)=>void): KeyValue
  {
    var value = this.store.get(key);
    if (value){
      fn && fn(key);
      if (this.isLink(value)){
        if (this.isCollectionLink(value)){
          var regex = new RegExp(value.slice(1, value.length-1));
          var allKeys = this.store.allKeys();
          // get the keys matching our regex but only those that aren't links
          // otherwise we could get dupplicates (maybe not needed)
          var keys = _.filter(allKeys, (key)=>{
            if(key.match(regex)){
              var value = this.store.get(key);
              return !this.isLink(value);
            }
            return false;
          });
          return {
            key: key,
            value: _.reduce(keys, function(memo, key){
                memo[key] = 'insync';
                return memo;
            }, {})
          }
        } else {
          return this.traverseLinks(value);
        }
      } else {
        return {key: key, value: value};
      }
    }
  }

  constructor(store?: Storage.Store.IStore) {
    this.store = store || new Storage.Store.LocalStore();
  }

  create(keyPath: string[], doc: any): Promise<string>
  {
    return new Promise((resolve, reject) => {
      if(!doc._cid){
        doc._cid = Util.uuid();
      }
      this.createCollectionLink(keyPath[0]);
      this.store.put(this.makeKey(keyPath.concat(doc._cid)), doc);
      resolve(doc._cid);
    });
  }

  fetch(keyPath: string[]): Promise<any>
  {
    return new Promise((resolve, reject) => {
      var keyValue = this.traverseLinks(this.makeKey(keyPath));
      if(keyValue){
        resolve(keyValue.value);
      }else {
        reject(InvalidKeyError());
      }
    });
  }

  put(keyPath: string[], doc: {}, opts: {}): Promise<void>
  {
    var
      key = this.makeKey(keyPath),
      keyValue = this.traverseLinks(this.makeKey(keyPath));

    if(keyValue){
      this.store.put(keyValue.key, Util.merge(keyValue.value, doc));
    }else{
      //
      // Upsert
      //
      this.store.put(key, doc);
    }
    return Promise.resolved(void 0);
  }

  del(keyPath: string[]): Promise<void>
  {
    this.traverseLinks(this.makeKey(keyPath), (key)=>{
      this.store.del(this.makeKey(keyPath));
    });
    return Promise.resolved(void 0);
  }

  link(newKeyPath: string[], oldKeyPath: string[]): Promise<void>
  {
    // Find all the keypaths with oldKeyPath as subpath, replacing them by the new subkeypath
    var oldKey = this.makeKey(oldKeyPath);
    var newKey = this.makeKey(newKeyPath);

    var keys = this.store.allKeys(); //localCache.getKeys();
    for(var i=0; i<keys.length; i++){
      if(keys[i].substring(0, oldKey.length) === oldKey){
        // Make Link
        var link = keys[i].replace(oldKey, newKey);
        this.store.put(link, keys[i]);
      }
    }
    return Promise.resolved(void 0);
  }

  //
  // ISetStorage
  //
  // Save as an Object where key = itemId, value = add|rm|synced
  //
  add(keyPath: string[], itemsKeyPath: string[], itemIds:string[], opts): Promise<void>
  {
    var
      key = this.makeKey(keyPath),
      itemIdsKeys = this.contextualizeIds(itemsKeyPath, itemIds),
      keyValue = this.traverseLinks(key),
      oldItemIdsKeys = keyValue ? keyValue.value || {} : {},
      newIdKeys = {};

    if(keyPath.length === 1 && itemsKeyPath.length === 1){
      // Can be redundant sometimes, but its cheap (and needed)
      this.createCollectionLink(keyPath[0]);
      return Promise.resolved<void>();
    }

    key = keyValue ? keyValue.key : key;
    _.each(itemIdsKeys, (id)=>{
      newIdKeys[id] = opts.insync ? 'insync' : 'add';
    })
    this.store.put(key, _.extend(oldItemIdsKeys, newIdKeys));

    return Promise.resolved(void 0);
  }

  remove(keyPath: string[], itemsKeyPath: string[], itemIds:string[], opts): Promise<void>
  {
    var
      key = this.makeKey(keyPath),
      itemIdsKeys = this.contextualizeIds(itemsKeyPath, itemIds),
      keyValue = this.traverseLinks(key);

    if(itemIds.length === 0) return Promise.resolved(void 0); // do nothing

    if(keyValue){
      var keysToDelete = keyValue.value;
      _.each(itemIdsKeys, (id)=>{
        this.traverseLinks(id, (itemKey)=>{
          if(opts.insync){
            delete keysToDelete[id];
          }else{
            keysToDelete[id] = 'rm';
          }
        });
      });
      this.store.put(keyValue.key, keysToDelete);
      return Promise.resolved(void 0)
    }else{
      return Promise.rejected<void>(InvalidKeyError());
    }
  }

  find(keyPath: string[], query: {}, opts) : Promise<any[]>
  {
    var result = {};

    var getItems = (collection) => {
      _.each(_.keys(collection), (key)=>{
        var op = collection[key]
        if(op !== 'rm' || !opts.snapshot){
          var keyValue = this.traverseLinks(key);
          if(keyValue){
            var
              item = keyValue.value,
              id = item._cid || item._id;
            if(!(result[id]) || op === 'insync'){
              if(!opts.snapshot) item.__op = op;
              result[id] = item;
            }
          }
        }
      });
      var values = _.values(result);
      if(query && query['cond']){
        values = _.filter(values, query['cond']);
      }
      return values;
    }

    if(keyPath.length === 1){
      var keyValue = this.traverseLinks(keyPath[0]);
      return keyValue ? Promise.resolved(getItems(keyValue.value)) :
                        Promise.resolved([]);
    }else{
      return this.fetch(keyPath).then((collection) => getItems(collection),
        // This is wrong but necessary due to how .all api works right now...
        (err) => []);
    }
  }

  //
  // ISeqStorage
  //
  all(keyPath: string[], query, opts) : Promise<any[]>
  {
    return new Promise((resolve, reject) =>{
      var key = this.makeKey(keyPath);
      var keyValue = this.traverseLinks(key);
      var itemKeys = keyValue ? keyValue.value || [] : [];
      key = keyValue ? keyValue.key : key;

      var all = [];
      var visited = {};

      if(itemKeys.length === 0) return resolve(all);

      var traverse = (i) => {
        var item = itemKeys[i];
        if(!item || item.next < 0) return; //last pointer
          var itemId = item._id || item._cid;
          var itemKeyPath = this.parseKey(item.key);
          var op = item.sync;
          if(op !== 'rm'){// || !options.snapshot){
            var itemKeyValue = this.traverseLinks(item.key);
            if(itemKeyValue){
              var doc = itemKeyValue.value;
              if(!opts.snapshot) doc.__op = op; //why?
              var iDoc = {
                id: itemId,
                doc: doc
              };
              all.push(iDoc);
            }
          }
          if(visited[itemId]) return; //circular sequence
          visited[itemId] = true;
          traverse(item.next);
      };

      var first = itemKeys[0].next;
      traverse(first);
      resolve(all);
    });
  }

  private initSequence(seq){
    if(seq.length < 2){
      seq[0] = { //first
        _id: '##@_begin',
        prev: -1,
        next: 1
      };
      seq[1] = { //last
        _id: '##@_end',
        prev: 0,
        next: -1
      }
    }
  }

  deleteItem(keyPath: string[], id: string, opts): Promise<void>
  {
    return new Promise<void>((resolve, reject) =>{
      var key = this.makeKey(keyPath);
      var keyValue = this.traverseLinks(key);
      var itemKeys = keyValue ? keyValue.value || [] : [];
      key = keyValue ? keyValue.key : key;

      var item = _.find(itemKeys, (item: ListItem) => {
        return item._id === id || item._cid === id;
      });

      // We do not reject the promise if trying to delete an unexistent item.
      if(item){
        if(opts.insync || opts.noremote){ //noremote implies insync
          itemKeys[itemKeys[item.prev].next] = 'deleted';
          itemKeys[item.prev].next = item.next;
          itemKeys[item.next].prev = item.prev;
        }else{
          item.sync = 'rm'; //tombstone
        }

        this.store.put(key, itemKeys);
      }

      return resolve();
    });
  }

  insertBefore(keyPath: string[], id: string, itemKeyPath: string[], opts): Promise<{id: string; refId: string}>
  {
    id = id || '##@_end';
    return new Promise((resolve, reject) => {
      var key = this.makeKey(keyPath);
      var itemKey = this.makeKey(itemKeyPath);
      var keyValue = this.traverseLinks(key);
      var itemKeys = keyValue ? keyValue.value || [] : [];
      key = keyValue ? keyValue.key : key;
      this.initSequence(itemKeys);

      // Check for already inserted id
      if(opts.id){
      var found = _.find(itemKeys, function(item: ListItem){
        return item._id === opts.id || item._cid === opts.id;
      });
      if(found){
        var next = itemKeys[found.next];
        if(next._id === id || next._cid === id){
          //Already at the right place
          return resolve({id: opts.id, refId: id});
        }else{
          //Already in the sequence but not at the right place
          return reject(Error('Tried to insert duplicate container'));
        }
      }
      }

      var refItem = _.find(itemKeys, (item: ListItem) => {
        return item._id === id || item._cid === id;
      });

      if(!refItem) return reject(Error('reference item not found'));
      var prevItem = itemKeys[refItem.prev];

      var newItem: any = {
        key: itemKey,
        sync: opts.insync || opts.noremote ? 'insync' : 'ib', //noremote implied insync
        prev: refItem.prev,
        next: prevItem.next
      };
      if(opts.id){
        newItem._id = opts.id;
      }else{
        newItem._cid = Util.uuid();
      }

      itemKeys.push(newItem);
      prevItem.next = refItem.prev = itemKeys.length-1;

      this.store.put(key, itemKeys);
      var refId = newItem.next !== '##@_end' ? newItem.next : null;
      resolve({id: newItem._id || newItem._cid, refId: refId});
    });
  }

  ack(keyPath: string[], id: string, sid: string, opts): Promise<void>
  {
    var key = this.makeKey(keyPath);
    var keyValue = this.traverseLinks(key);
    var itemKeys = keyValue ? keyValue.value || [] : [];
    key = keyValue ? keyValue.key : key;

    var item = _.find(itemKeys, (item: ListItem) => {
      return opts.op === 'ib' && item._cid === id ||
             opts.op === 'rm' && item._id === sid;
    });
    // If we get an ack for an item we didn't created ourself, just return. This
    // happens when having two synced sequences on the same client (i.e. during testing)
    if(!item) return Promise.resolved(void 0);
    // if(!item) return Promise.rejected(Error(''+ServerError.INVALID_ID));

    if(sid) item._id = sid;
    switch(item.sync) {
      case 'rm':
        log('Removing ', item);
        itemKeys[itemKeys[item.prev].next] = 'deleted';
        itemKeys[item.prev].next = item.next;
        itemKeys[item.next].prev = item.prev;
        //TODO: remove tombstone
        break;
      case 'ib':
        item.sync = 'insync';
        break;
    }
    this.store.put(key, itemKeys);
    return Promise.resolved(void 0);
  }
}

}
