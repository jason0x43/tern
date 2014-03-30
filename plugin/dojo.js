(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    return mod(require("../lib/infer"), require("../lib/tern"));
  if (typeof define == "function" && define.amd) // AMD
    return define(["../lib/infer", "../lib/tern"], mod);
  mod(tern, tern);
})(function(infer, tern) {
  "use strict";

  function flattenPath(path) {
    if (!/(^|\/)(\.\/|[^\/]+\/\.\.\/)/.test(path)) return path;
    var parts = path.split("/");
    for (var i = 0; i < parts.length; ++i) {
      if (parts[i] == "." || !parts[i]) parts.splice(i--, 1);
      else if (i && parts[i] == "..") parts.splice(i-- - 1, 2);
    }
    return parts.join("/");
  }

  function resolveName(name, data) {
    var excl = name.indexOf("!");
    if (excl > -1) name = name.slice(0, excl);

    var opts = data.options;
    var hasExt = /\.js$/.test(name);
    if (hasExt || /^(?:\w+:|\/)/.test(name))
      return name + (hasExt ? "" : ".js");

    var base = opts.baseURL || "";
    if (name[0] === '.')
      base = path.dirname(data.currentFile) + '/';
    else {
      if (base && base.charAt(base.length - 1) != "/") base += "/";
      if (opts.paths) {
        var known = opts.paths[name];
        if (known) return flattenPath(base + known + ".js");
        var dir = name.match(/^([^\/]+)(\/.*)$/);
        if (dir) {
          known = opts.paths[dir[1]];
          if (known) return flattenPath(base + known + dir[2] + ".js");
        }
      }
    }
    return flattenPath(base + name + ".js");
  }

  function getRequire(data) {
    if (!data.require) {
      data.require = new infer.Fn("require", infer.ANull, [infer.cx().str], ["module"], new infer.AVal());
      data.require.computeRet = function(_self, _args, argNodes) {
        if (argNodes.length && argNodes[0].type == "Literal" && typeof argNodes[0].value == "string")
          return getInterface(argNodes[0].value, data);
        return infer.ANull;
      };
    }
    return data.require;
  }

  function getInterface(name, data) {
    if (name == "require") return getRequire(data);
    if (name == "module") return infer.cx().definitions.dojo.module;

    if (data.options.override && Object.prototype.hasOwnProperty.call(data.options.override, name)) {
      var over = data.options.override[name];
      if (typeof over == "string" && over.charAt(0) == "=") return infer.def.parsePath(over.slice(1));
      if (typeof over == "object") {
        known = getKnownModule(name, data);
        if (known) return known;
        var scope = data.interfaces[stripJSExt(name)] = new infer.Obj(null, stripJSExt(name));
        infer.def.load(over, scope);
        return scope;
      }
      name = over;
    }

    if (!/^(https?:|\/)|\.js$/.test(name))
      name = resolveName(name, data);
    name = flattenPath(name);

    var known = getKnownModule(name, data);

    if (!known) {
      known = getModule(name, data);
      data.server.addFile(name);
    }
    return known;
  }

  function getKnownModule(name, data) {
    return data.interfaces[stripJSExt(name)];
  }

  function getModule(name, data) {
    var known = getKnownModule(name, data);
    if (!known) {
      known = data.interfaces[stripJSExt(name)] = new infer.AVal();
      known.origin = name;
    }
    return known;
  }

  var EXPORT_OBJ_WEIGHT = 50;

  function stripJSExt(f) {
    return f.replace(/\.js$/, '');
  }

  var path = {
    dirname: function(path) {
      var lastSep = path.lastIndexOf("/");
      return lastSep == -1 ? "" : path.slice(0, lastSep);
    },
    relative: function(from, to) {
      if (to.indexOf(from) === 0) return to.slice(from.length);
      else return to;
    },
    join: function(a, b) {
      if (a && b) return a + "/" + b;
      else return (a || "") + (b || "");
    },
  };

  infer.registerFunction("dojo", function(_self, args, argNodes) {
    var server = infer.cx().parent, data = server && server._dojo;
    if (!data || !args.length) return infer.ANull;

    var name = data.currentFile;
    var out = getModule(name, data);

    var deps = [], fn, exports;
    if (argNodes && args.length > 1) {
      var node = argNodes[args.length == 2 ? 0 : 1];
      if (node.type == "Literal" && typeof node.value == "string") {
        deps.push(getInterface(node.value, data));
      } else if (node.type == "ArrayExpression") for (var i = 0; i < node.elements.length; ++i) {
        var elt = node.elements[i];
        if (elt.type == "Literal" && typeof elt.value == "string") {
          if (elt.value == "exports") {
            exports = new infer.Obj(true);
            deps.push(exports);
            out.addType(exports, EXPORT_OBJ_WEIGHT);
          } else {
            deps.push(getInterface(elt.value, data));
          }
        }
      }
    } else if (argNodes && args.length == 1 && argNodes[0].type == "FunctionExpression" && argNodes[0].params.length) {
      // Simplified CommonJS call
      exports = new infer.Obj(true);
      deps.push(getInterface("require", data), exports);
      out.addType(exports, EXPORT_OBJ_WEIGHT);
      fn = args[0];
    }

    if (!fn) {
      fn = args[Math.min(args.length - 1, 2)];
      if (!fn.isEmpty() && !fn.getFunctionType()) fn = null;
    }

    if (fn) fn.propagate(new infer.IsCallee(infer.ANull, deps, null, out));
    else if (args.length) args[0].propagate(out);

    return infer.ANull;
  });

  // Parse simple ObjectExpression AST nodes to their corresponding JavaScript objects.
  function parseExprNode(node) {
    switch (node.type) {
    case "ArrayExpression":
      return node.elements.map(parseExprNode);
    case "Literal":
      return node.value;
    case "ObjectExpression":
      var obj = {};
      node.properties.forEach(function(prop) {
        var key = prop.key.name || prop.key.value;
        obj[key] = parseExprNode(prop.value);
      });
      return obj;
    }
  }

  infer.registerFunction("dojoConfig", function(_self, _args, argNodes) {
    var server = infer.cx().parent, data = server && server._dojo;
    if (data && argNodes && argNodes.length && argNodes[0].type == "ObjectExpression") {
      var config = parseExprNode(argNodes[0]);
      for (var key in config) if (config.hasOwnProperty(key)) {
        var value = config[key], exists = data.options[key];
        if (!exists) {
          data.options[key] = value;
        } else if (key == "paths") {
          for (var path in value) if (value.hasOwnProperty(path) && !data.options.paths[path])
            data.options.paths[path] = value[path];
        }
      }
    }
    return infer.ANull;
  });

  function preCondenseReach(state) {
    var interfaces = infer.cx().parent._dojo.interfaces;
    var rjs = state.roots["!dojo"] = new infer.Obj(null);
    for (var name in interfaces) {
      var prop = rjs.defProp(name.replace(/\./g, "`"));
      interfaces[name].propagate(prop);
      prop.origin = interfaces[name].origin;
    }
  }

  function postLoadDef(data) {
    var cx = infer.cx(), interfaces = cx.definitions[data["!name"]]["!dojo"];
    data = cx.parent._dojo;
    if (interfaces) for (var name in interfaces.props) {
      interfaces.props[name].propagate(getInterface(name, data));
    }
  }

  tern.registerPlugin("dojo", function(server, options) {
    server._dojo = {
      interfaces: Object.create(null),
      options: options || {},
      currentFile: null,
      server: server
    };

    server.on("beforeLoad", function(file) {
      this._dojo.currentFile = file.name;
    });
    server.on("reset", function() {
      this._dojo.interfaces = Object.create(null);
      this._dojo.require = null;
    });
    return {
      defs: defs,
      passes: {
        preCondenseReach: preCondenseReach,
        postLoadDef: postLoadDef
      },
    };
  });

  var defs = {
    "!name": "dojo",
    "!define": {
      module: {
        id: "string",
        uri: "string",
        config: "fn() -> ?",
        exports: "?"
      }
    },
    require: {
      "!type": "fn(deps: [string], callback: fn()) -> !custom:dojo",
      load: "fn(context: ?, moduleName: string, url: string)",
      config: "fn(config: ?) -> !custom:dojoConfig",
      version: "string",
      isBrowser: "bool"
    },
    define: {
      "!type": "fn(deps: [string], callback: fn()) -> !custom:dojo",
      amd: {
        jQuery: "bool"
      }
    }
  };
});
