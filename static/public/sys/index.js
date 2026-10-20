// minty needs a secure context to register its service worker.
document.addEventListener("DOMContentLoaded", function () {
  var host = window.location.hostname;
  var local = host === "localhost" || host === "127.0.0.1";
  if (window.location.protocol === "http:" && !local) {
    var address = document.getElementById("uv-address");
    if (address) {
      address.disabled = true;
      address.placeholder = "please turn on HTTPS to use minty";
    }
  }
});
