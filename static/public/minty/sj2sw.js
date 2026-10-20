/* global $scramjetController */
// minty's Scramjet v2 service worker. It only forwards requests under the Scramjet v2
// prefix (/minty/sj2/) to the controller running in the browser page; everything else
// (including Ultraviolet and Scramjet v1 traffic) is left alone.
importScripts("/minty/sj2lib/controller.sw.js");

addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
