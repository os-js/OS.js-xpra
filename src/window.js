import Layer from './layer.js';

const Window = OSjs.require('core/window');

///////////////////////////////////////////////////////////////////////////////
// WINDOW
///////////////////////////////////////////////////////////////////////////////

export default class ApplicationXpraWindow extends Window {

  constructor(win, app, metadata) {
    super('ApplicationXpraWindow', {
      icon: metadata.icon,
      title: win.meta.title || metadata.name,
      minimized: win.meta.minimized === 1,
      maximized: win.meta.maximized === 1,
      fullscreen: win.meta.fullscreen === 1,
      w: win.w,
      h: win.h
    }, app);

    this.x = win.x;
    this.y = win.y;
    this.canvas = null;
    this.layer = new Layer(win.wid, win.props);
    this.wid = win.wid;
    this.overlays = {};
  }

  destroy() {
    this.layer.destroy();

    return super.destroy(...arguments);
  }

  move(x, y) {
    this.x = x;
    this.y = y;
  }

  init(wmRef, app) {
    const root = super.init(...arguments);

    this.canvas = document.createElement('canvas');
    root.appendChild(this.canvas);

    this.layer.init(this.canvas, this.getGeometry());
    this.layer.updateCanvases(this.getGeometry());

    return root;
  }

  removeOverlay(wid) {
    if ( this.overlays[wid] ) {
      delete this.overlays[wid];
    }
  }

  addEvents(wid, canvas) {
    const topMargin = this._$top.offsetHeight;

    canvas.addEventListener('mousemove', (ev) => {
      this._app.client.processMouse(wid, ev, null, false, topMargin);
    });
    canvas.addEventListener('mousedown', (ev) => {
      this._app.client.processMouse(wid, ev, true, false, topMargin);
    });
    canvas.addEventListener('mouseup', (ev) => {
      this._app.client.processMouse(wid, ev, false, false, topMargin);
    });
    canvas.addEventListener('wheel', (ev) => {
      this._app.client.processMouse(wid, ev, false, true, topMargin);
    });
    canvas.addEventListener('mouseweheel', (ev) => {
      this._app.client.processMouse(wid, ev, false, true, topMargin);
    });
    canvas.addEventListener('DOMMouseScroll', (ev) => {
      this._app.client.processMouse(wid, ev, false, true, topMargin);
    });
  }

  addOverlay(wid, layer, x, y, w, h) {
    if ( !this.canvas ) {
      console.warn('No canvas for', layer);
      return;
    }

    const geom = this.getGeometry();
    const coverlay = document.createElement('canvas');
    coverlay.setAttribute('data-wid', wid);
    coverlay.style.position = 'absolute';
    coverlay.style.zIndex = 10;
    coverlay.style.left = String(x - geom.x) + 'px';
    coverlay.style.top = String(y - geom.y) + 'px';

    this._$root.appendChild(coverlay);

    layer.init(coverlay, {w, h});

    this.addEvents(wid, coverlay);

    this.overlays[wid] = layer;
  }

  getClientProperties() {
    return this.layer.getClientProperties();
  }

  getGeometry() {
    const {w, h} = this._dimension;
    const {x, y} = this._position;

    return {x, y, w, h};
  }
}

