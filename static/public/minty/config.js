// This file overwrites the stock UV config.js

self.__uv$config = {
  prefix: "/minty/ixl/",
  bare: "/bare/",
  encodeUrl: Ultraviolet.codec.base64.encode,
  decodeUrl: Ultraviolet.codec.base64.decode,
  handler: "/minty/handler.js",
  client: "/minty/client.js",
  bundle: "/minty/bundle.js",
  config: "/minty/config.js",
  sw: "/minty/fr.sw.js",
};
