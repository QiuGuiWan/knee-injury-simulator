/* 内嵌资产回退：file:// 双击打开或 fetch 被禁时，用 <script> 注入 base64 资产。
 * 正常 http 环境不会走到这里（fetch 优先），因此不增加首屏下载量。 */
window.KneeEmbed = (function () {
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function load(url, key) {
    return new Promise(function (resolve, reject) {
      if (window[key]) return resolve(window[key]);
      const s = document.createElement('script');
      s.src = url;
      s.onload = function () {
        if (window[key]) resolve(window[key]);
        else reject(new Error(key + ' 内容为空'));
      };
      s.onerror = function () { reject(new Error(url + ' 不可用')); };
      document.head.appendChild(s);
    });
  }
  return { b64ToBuf: b64ToBuf, load: load };
})();