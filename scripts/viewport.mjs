/**
 * Screen-size options shared by the commands that look at a page.
 *
 * Chrome keeps an emulated screen size only while the CDP session that set it stays attached, and
 * every CLI command is its own session. So the size is applied inside the command that needs it,
 * on a session held for exactly that long. Puppeteer's page.setViewport is avoided on purpose: it
 * reloads the page whenever the mobile flag changes, which would throw away the state of the tab.
 */

const VIEWPORT_OPTIONS_WITH_VALUES = new Set(['--viewport', '--scale']);
const VIEWPORT_FLAGS = new Set(['--mobile']);

// Accepts a Buffer or the Uint8Array that Puppeteer returns from screenshot().
export function pngSize(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG image');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function optionValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value after ${name}`);
  return value;
}

export function parseViewport(args) {
  const size = optionValue(args, '--viewport');
  const scale = optionValue(args, '--scale');
  const isMobile = args.includes('--mobile');
  if (size === null) {
    if (isMobile || scale !== null) throw new Error('--mobile and --scale need --viewport <width>x<height>');
    return null;
  }
  const match = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(size);
  if (!match) throw new Error(`Invalid --viewport value: ${size}. Expected <width>x<height>, for example 375x667`);
  const deviceScaleFactor = scale === null ? 1 : Number(scale);
  if (!(deviceScaleFactor > 0 && deviceScaleFactor <= 8)) throw new Error(`Invalid --scale value: ${scale}. Expected a number from 0 (exclusive) to 8`);
  return { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor, mobile: isMobile };
}

export function stripViewportArgs(args) {
  const stripped = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VIEWPORT_OPTIONS_WITH_VALUES.has(args[i])) i += 1;
    else if (!VIEWPORT_FLAGS.has(args[i])) stripped.push(args[i]);
  }
  return stripped;
}

// Runs the callback with a CDP session that holds the requested size, or no size at all.
async function withSession(page, viewport, callback) {
  const session = await page.createCDPSession();
  try {
    if (viewport) {
      await session.send('Emulation.setDeviceMetricsOverride', viewport);
      if (viewport.mobile) await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    return await callback(session);
  } finally {
    // Detaching drops the overrides, but not always before the next command looks at the page.
    if (viewport?.mobile) await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    if (viewport) await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await session.detach().catch(() => {});
  }
}

export async function withViewport(page, viewport, callback) {
  if (!viewport) return callback();
  return withSession(page, viewport, () => callback());
}

// Captures the viewport, the full page, or one element as PNG bytes, at the requested size.
//
// The capture is sent on the same session that holds the size. A capture sent on another session,
// which is what page.screenshot() does, honours the width but not the scale. The element is located
// by its position and captured beyond the viewport, because Puppeteer's element capture first waits
// for an IntersectionObserver that never fires on a background tab.
export async function capturePage(page, { viewport = null, fullPage = false, selector = null } = {}) {
  if (fullPage && selector) throw new Error('Use only one of --full or --selector');
  return withSession(page, viewport ?? await heldSize(page, fullPage || selector), async (session) => {
    const layoutWidth = () => page.evaluate(() => innerWidth);
    const before = viewport ? await layoutWidth() : null;
    let clip = null;
    if (selector) {
      const box = await page.evaluate((query) => {
        const node = document.querySelector(query);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      }, selector);
      if (!box) throw new Error(`No element matches ${selector}`);
      if (!(box.width > 0 && box.height > 0)) throw new Error(`Element ${selector} has no visible size`);
      clip = { ...box, scale: 1 };
    }
    // A full-page capture has no clip: Chrome then captures the whole document, without the scrollbar gutter.
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png', ...(clip ? { clip } : {}), captureBeyondViewport: Boolean(clip || fullPage),
    });
    const image = Buffer.from(data, 'base64');
    // A capture at the wrong size looks plausible and misleads every measurement taken from it,
    // so the requested size must still hold after the capture and must show in the image.
    const after = viewport ? await layoutWidth() : null;
    if (after !== before) throw new Error(`The page width changed from ${before} to ${after} px during the capture`);
    const actual = pngSize(image);
    const expected = expectedImageSize(viewport, { fullPage, selector });
    if (expected && (actual.width !== expected.width || actual.height !== expected.height)) {
      throw new Error(`Screenshot is ${actual.width}x${actual.height}, but --viewport asked for ${expected.width}x${expected.height}`);
    }
    return image;
  });
}

// A capture beyond the viewport makes Chrome drop the page's scrollbar, and the page stays that much
// wider afterwards. Chrome lays the page out again when an emulated size that was held across the
// capture is cleared, so a capture without a requested size holds the page's own size, one pixel
// taller: an override equal to the real size changes nothing and is not laid out again.
async function heldSize(page, beyondViewport) {
  if (!beyondViewport) return null;
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  return { width, height: height + 1, deviceScaleFactor: 0, mobile: false };
}

// What the image must measure when the request fixes its size. A full-page or element capture is as
// large as its content, so only a plain viewport capture has a size to hold it to.
export function expectedImageSize(viewport, { fullPage = false, selector = null } = {}) {
  if (!viewport || fullPage || selector) return null;
  return {
    width: Math.round(viewport.width * viewport.deviceScaleFactor),
    height: Math.round(viewport.height * viewport.deviceScaleFactor),
  };
}

export const SESSION_SCOPED_NOTE = 'Note: an Emulation override ends with this command, because Chrome drops it when the CDP session that set it detaches. '
  + 'For a screen size, pass --viewport <width>x<height> [--mobile] [--scale <n>] to screenshot, eval, or nav instead.';
