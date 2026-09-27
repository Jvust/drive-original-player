/* A registration being ready does not mean its worker controls this page.
 * In particular, /gallery/ can initially be controlled by the root worker. */
(() => {
  "use strict";
  let registrationPromise;
  const scriptURL = new URL("./sw.js?v=navigation-2", location.href).href;
  function waitForController() {
    const sw = navigator.serviceWorker;
    return new Promise((resolve, reject) => {
      const finish = (error, worker) => {
        clearTimeout(timer);
        sw.removeEventListener("controllerchange", check);
        error ? reject(error) : resolve(worker);
      };
      const check = () => {
        const worker = sw.controller;
        if (worker?.scriptURL === scriptURL && worker.state !== "redundant") finish(null, worker);
      };
      const timer = setTimeout(() => finish(new Error("媒体服务接管超时，请稍后重试。")), 15000);
      sw.addEventListener("controllerchange", check);
      check();
    });
  }
  async function ready() {
    if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持媒体服务。");
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register(scriptURL, {
        scope: "./", updateViaCache: "none"
      }).catch(error => { registrationPromise = null; throw error; });
    }
    await registrationPromise;
    return waitForController();
  }
  async function send(data) {
    const worker = await ready();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = error => {
        clearTimeout(timer);
        channel.port1.close();
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error("媒体服务未确认授权，请重试。")), 5000);
      channel.port1.onmessage = event => finish(event.data?.ok ? null : new Error("媒体授权失败。"));
      try { worker.postMessage(data, [channel.port2]); }
      catch (error) { finish(error); }
    });
  }
  window.DriveWorkerClient = { ready, send };
})();
