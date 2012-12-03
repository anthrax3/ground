/**
  Ground Web Framework. Method Overload. (c) OptimalBits 2011-2012.
*/
/**
  Method Overload.
  
  This module provides a mechanism for cleaner method overload.
  
*/

/// <reference path="../third/underscore.browser.d.ts" />


/*
References:
http://stackoverflow.com/questions/332422/how-do-i-get-the-name-of-an-objects-type-in-javascript
*/

export function overload(map:{}) {
  return function(...args:any[]) : any {
    
    // Create string with parameters
    var key = '';
    if(args.length){
      if(!_.isUndefined(args[0])){
        key += type(args[0]);
      }
      for(var i=1; i<args.length;i++){
        if(!_.isUndefined(args[i])){
          key += ' ' + type(args[i]);
        }
      }
    }
    
    // Match signature
    if(map[key]){
      return map[key].apply(this, args);
    }else{
      throw new Error("Not matched function signature: "+key);
    }
  }
}

function type(obj:any){
  if(obj && obj.getName){
    return obj.getName();
  }else{
    return Object.prototype.toString.call(obj).match(/^\[object (.*)\]$/)[1]
  }
}
