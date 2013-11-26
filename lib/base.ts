/**
  Ground Web Framework (c) 2012 Optimal Bits Sweden AB
  MIT Licensed.
*/
/**
  Base Class.
  
  Most classes extends the base class in order to be observable,
  get property bindings and reference counting.
*/

/// <reference path="util.ts" />
/// <reference path="event.ts" />
/// <reference path="undo.ts" />

// TODO: we need a portable stack trace.
/*declare class Error {
  stack : string;
}
*/
// Error.prototype.stack = Error.prototype.stack || '';

/**
  @module Gnd
*/
module Gnd {
"use strict";

export interface IObservable 
{
  // TODO: Implement
}

export interface ISettable
{
  set(keyOrObj, val?: any, options?: {});
}

export interface IGettable
{
  get(key: string): any;
}

export interface BaseEvents
{
  on(evt: string, ...args: any[]);
  /**
  * Fired when any property changes.
  *
  * @event changed:
  * @param obj {any} 
  * @param options {any}
  */
  on(evt: 'changed:', obj: any, options: any); // TODO: Define options interface
  
  /**
  * Fired when the object is destroyed.
  *
  * @event destroy:
  */
  on(evt: 'destroy:');
}

/**
 * The {{#crossLink "Base"}}{{/crossLink}} class is the base class for all 
 * objects in Ground.
 *
 * @class Base
 * @extends EventEmitter
 * @constructor
 **/
export class Base extends EventEmitter implements ISettable, IGettable, BaseEvents
{
  private _refCounter: number = 1;
  private _bindings: any = {};
  private _destroyed: boolean;
  private _destroyedTrace: string;
  private _undoMgr: UndoManager = new UndoManager();
  
  /**
    Retains the given objects (see reference count for details).

    @method retain
    @static
    @param objs* {Array | Any} object or objects to retain. If any of the objs
    is null or undefined, nothing is done for that obj.
  */
  static retain(objs){
    var items = _.isArray(objs) ? objs :arguments;
    _.each(items, function(obj){
      obj && obj.retain();
    });
  }

  /**
    Release the given objects (see reference count for details).
 
    @method release
    @static
    @param objs* {Array | Any} object or objects to release. If any of the objs
      is null or undefined, nothing is done for that obj.
  */
  static release(...objs: Base[]);
  static release(objs: any){
    var items = _.isArray(objs) ? objs :arguments;
    _.each(items, function(obj){
      obj && obj.release();
    });
  }
  
  /**
   *  Sets a property and notifies any listeners attached to it if changed.
   *
   *  Code smell: when setting a whole object of properties, if one of them
   *  is a function, nosync will be set to true and none of the properties will
   *  be synchronized...
   *  
   * @method set
   * @param {String} keypath 
   * @param {Object} val
   * @param {Object} [opts]
   * @chainable
   */
  set(keypath: string, val: any, opts?: {});
  
  /**
   *  
   * @method set
   * @param {Object} doc object with properties to set.
   * @param {Object} [opts]
   * @chainable
   */
  set(doc: {}, opts?: {});
  set(keypathOrObj, val?, opts?){
    var cage = {}, keypath, obj;
    if(_.isObject(keypathOrObj)){
      opts = val;
      obj = val = keypathOrObj;
      keypath = '';
    }else{
      keypath = keypathOrObj;
      // This is not entirely correct...
      obj = {};
      obj[keypath] = val;
    }
    if(set(this, keypath, val, cage, opts)){
      _.each(cage, function(val, key){
        val.emitter.emit(key, val.val, val.oldval, opts);
      });
      this.emit('changed:', obj, opts);  
    };
    return this;
  }
  
  willChange(keypath, val) {
    return val;
  }
  
  /**
   *  Gets a property.
   *
   * @method get 
   * @param {Object} key property to get.
   * @returns {any}
   */
  get(key: string): any
  {
    var 
      path = key.split('.'),
      result: any = this,
      len = path.length;
    
    if(!len) return;
    
    for(var i=0; i<len; i++){
      result = result[path[i]];
      result = _.isFunction(result) ? result.call(this) : result;    
      if(!_.isObject(result)) break;
    }
    
    return result;
  }
  
  
  /**
   * Creates a binding between two properties. 
   * Binded properties will be updated automatically as long as set method 
   * is used to updata them.
   * 
   * Note: If the keys have different values when binding, the caller will get
   * the value of the target object key.
   *
   * @method bind
   * @param {String} key Key to bind in the source object
   * @param {Base} object Target object to bind this objects key
   * @param {String} [objectKey] The key in the destination object to bind the
   * key in this object.
   *
   */
  bind(key: string, object: Base, objectKey?: string){
    var dstKey = objectKey || key

    this.unbind(key)
  
    var dstListener = _.bind(object.set, object, dstKey)
    this.on(key, dstListener)
  
    var srcListener = _.bind(this.set, this, key)
    object.on(dstKey, srcListener)
  
    this._bindings[key] = [dstListener, object, dstKey, srcListener];
  
    // sync
    this.set(key, object[dstKey])
  
    return this
  }
  /**
   *
   * Removes a binding.
   *
   * @method unbind
   * @param {String} key Key to unbind.
   *
  */
  unbind(key: string)
  {
    var bindings = this._bindings
    if( (bindings!=null) && (bindings[key]) ){
      var binding = bindings[key]
      this.removeListener(key, binding[0])
      binding[1].removeListener(binding[2], binding[3])
      delete bindings[key]
    }
  }
  
  /**
    Begins an undo operation over setting a given key to a value.
  */
  beginUndoSet(key)
  {
    var base = this
    ;(function(value){
      this.undoMgr.beginUndo(function(){
        base.set(key, value)
    }, name)}(this[key]))
  }
  /**
    Ends an undo operation over setting a given key to a value.
  */
  endUndoSet(key)
  {
    var base = this
    ;(function(value){
      this.undoMgr.endUndo(function(){
        base.set(key, value)
    })}(this[key]))
  }
  
  /**
    Sets a key value while registering it as an undo operation
  */
  undoSet(key, value, fn)
  {
    this.beginUndoSet(key)
    this.set(key, value)
    this.endUndoSet(key)
  }
  
  /**
   * Destroys this object. Removes all event listeners and cleans itself up.
   * Note: this method should never be called directly.
   *  
   * @method destroy
   * @protected
   */
  destroy()
  {
    this.emit('destroy:');
    this._destroyed = true;
    this._destroyedTrace = "";// Error().stack;
    this.off();
  }
  
  /**
   * Retains a reference of this object.
   *  
   * @method retain
   * @chainable
   *
   */
  retain(): Base
  {
    if(this._destroyed){
      throw Error("Cannot retain destroyed object");
    }
    this._refCounter++;
    return this;
  }
  
  /**
   * Releases a reference of this object.
   *
   * When all references of an object reaches zero, the object is automatically
   * destroyed (calling the destroy method) 
   *  
   * @method release
   * @chainable
   *
   */
  release(): Base
  {
    this._refCounter--;
    if(this._refCounter===0){
      this.destroy();
    }else if(this._refCounter < 0){
      var msg;
      if(this._destroyed){
        msg = "Object has already been released";
        if(this._destroyedTrace){
          msg += '\n'+this._destroyedTrace;
        }
        throw Error(msg);
      }else{
        msg = "Invalid reference count!";
      }
      throw Error(msg);
    }
    return this;
  }
  
  /**
   * Autoreleases a reference of this object.
   * i.e. releases the object in the next event loop.
   *  
   * @method autorelease
   * @chainable
   *
   */
  autorelease(): Base
  {
    Util.nextTick(() => this.release());
    return this;
  }
  
  /**
  * Checks if the object has been destroyed.
  *
  * @method isDestroyed
  * @return {Boolean}
  */
  isDestroyed(): boolean
  {
    return this._refCounter === 0;
  }
}

function set(root: Base, keypath: string, val:any, cage: {}, opts?)
{
  opts = opts || {};
  
  var changed = false;
  
  //
  // Traverse object using the keypath
  //
  var obj = root;
  var keys = keypath.split('.');
  
  var key = keys[0], dst, len = keys.length-1;
  for(var i=0; i<len; i++){
    dst = obj[key];
    if(!_.isObject(dst)){
      dst = obj[key] = {};
    } 
    
    obj = dst;
    key = keys[i+1];
  }
  
  if(_.isArray(val) || _.isPlainObject(val)){
    var lastKey = key;

    if(!_.isUndefined(obj) && (!lastKey || _.isUndefined(obj[lastKey])) && obj.willChange){
      val = obj.willChange(lastKey, val);
      if(!_.isPlainObject(val)){
        storeEvent(obj, cage, lastKey, val);
        // Investigate if in the future we could emit events for every property
        // of the model
        // generateEvents(obj, val, keys, cage);
        return true;
      }
    }
    
    _.each(val, function(subval, subkey: string){
      var subkeypath: string = keypath ? keypath+'.'+subkey : subkey;
      changed = set(root, subkeypath, subval, cage, opts) ? true : changed;
    });
  }else{ 
    var oldval = obj[key];
    
    // Virtual properties are a bit hacky right now
    var isVirtual = Util.isVirtualProperty(oldval);
    if(isVirtual){
      oldval = oldval.call(obj);
      opts.nosync = true;
    }
    
    changed = oldval !== val;
    if(changed || opts.force){
      if(obj.willChange){
        val = obj.willChange(key, val);
      }
      if(isVirtual){
        obj[key](val);
      }else{
        obj[key] = val;
      }

      if(obj.emit){
        storeEvent(obj, cage, key, val);
      }else if(obj !== root || key !== keypath){
        storeEvent(root, cage, keypath, val);
      }
      
      generateEvents(root, val, keys, keypath, cage);
    }
  }
  return changed;
}

function generateEvents(root: Base, val, keys: string[], keypath: string, cage){
  //
  // Generate events for all segments of the keypaths
  // creating an object with the change at every step
  //
  var res, key, len = keys.length-1;
  for(var i=len; i>0; i--){
    key = keys[i];
    res = {};
    res[key] = val;
    keypath = keypath.substr(0, (keypath.length-key.length)-1);
    
    // TODO: Also save the old value
    storeEvent(root, cage, keypath, res);
    val = res;
  }
}

function storeEvent(emitter, cage, keypath, val){
  var storedEvent = cage[keypath] = cage[keypath] || {};
  storedEvent.emitter = emitter;
  storedEvent.val = _.extend(val, storedEvent.val);
}

}
