/* 把预览页 + 一段测量脚本合成一个临时页，再用 headless Edge 的 --dump-dom
 * 把布局实测值当文本吐出来 —— 不靠看图猜"是不是被截断了"。
 * 注意预览页有 CSP（script-src 'nonce-xxx'），注入的脚本必须带上同一个 nonce。 */
const fs = require('fs');

const SRC = 'D:/APP/hermes/cache/scratch/hermes-ui/preview.html';
const OUT = 'D:/APP/hermes/cache/scratch/hermes-ui/measure.html';
const file = process.argv[2] || SRC;

const html = fs.readFileSync(file, 'utf8');
const m = html.match(/nonce-([A-Za-z0-9]+)/);
// 预览页是自带 head 的（没有 CSP），所以 nonce 是可选的；
// 真实面板的 HTML 有 CSP，那边必须要 nonce，不能删。
const nonce = m ? m[1] : '';
const nonceAttr = nonce ? ` nonce="${nonce}"` : '';

const probe = `<script${nonceAttr}>
setTimeout(function () {
  var R = function (e) {
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.right), Math.round(r.width)];
  };
  var q = function (s) { return document.querySelector(s); };
  var out = {};
  out.win = window.innerWidth;
  out.bodyScrollW = document.body.scrollWidth;
  out.appScrollW = q('#app') ? q('#app').scrollWidth : null;
  out.appOverflowX = q('#app') ? getComputedStyle(q('#app')).overflowX : null;
  out.home = R(q('#home'));
  out.homeList = R(q('.home-list'));
  out.row = R(q('.home-row'));
  out.rowTitle = q('.home-row .t') ? JSON.stringify(q('.home-row .t').textContent) : null;
  out.when = R(q('.home-row .when'));
  out.whenText = q('.home-row .when') ? JSON.stringify(q('.home-row .when').textContent) : null;
  out.more = R(q('#home-more'));
  out.hdrBtns = Array.prototype.map.call(document.querySelectorAll('#hdr .icon-btn'), function (b) {
    return b.id + '@' + JSON.stringify(R(b));
  });
  out.title = R(q('.hdr-title'));
  out.statusText = R(q('#status-text'));
  out.selects = Array.prototype.map.call(document.querySelectorAll('#composer-card select'), function (s) {
    return s.id + '@' + JSON.stringify(R(s)) + ' opts=' + s.options.length + ' disp=' + getComputedStyle(s).display;
  });
  out.art = R(q('.home-art svg'));
  out.homeHidden = q('#home').classList.contains('hidden');
  out.transcriptHidden = q('#transcript').classList.contains('hidden');
  out.composerCard = R(q('#composer-card'));
  out.sendCircle = R(q('#btn-send'));
  var app = q('#app');
  var appR = app ? app.getBoundingClientRect().right : 0;
  var appL = app ? app.getBoundingClientRect().left : 0;
  out.appBox = [Math.round(appL), Math.round(appR)];
  out.overflow = [];
  Array.prototype.forEach.call(
    document.querySelectorAll('#hdr *, .home-row *, #composer-card *'),
    function (e) {
      var r = e.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (r.right > appR + 0.5 || r.left < appL - 0.5) {
        out.overflow.push((e.id || e.tagName + '.' + e.className) + '=' + Math.round(r.left) + '..' + Math.round(r.right));
      }
    }
  );
  var pre = document.createElement('pre');
  pre.textContent = 'MEASURE-START\\n' + out.hdrBtns.concat(out.selects).join('\\n') +
    '\\n' + JSON.stringify(out, null, 1) + '\\nMEASURE-END';
  document.body.appendChild(pre);
}, 400);
</script>`;

fs.writeFileSync(OUT, html.replace(/<\/body>/, probe + '\n</body>'), 'utf8');
console.log('已生成 ' + OUT);
