/**
 * The page side of the bridge between a canvas page and the app
 * (docs/canvas-ui.md §8): the script injected into the page, the base
 * stylesheet placed before the agent's markup (§3.3), and the messages the two
 * exchange. The app side — mounting the page, posting patches and the theme,
 * answering sends — consumes these.
 */

import type { CanvasOp } from "../types/canvas";

export type SendRefusal =
	| "permission"
	| "readonly"
	| "offline"
	| "invalid"
	| "failed";

/**
 * The words of the refusals the app decides itself; `invalid` and `failed`
 * carry the bridge's or the server's own.
 */
export const SEND_REFUSAL_MESSAGES = {
	permission: "Answer the permission request first.",
	offline: "Not connected — try again when the connection is back.",
} as const satisfies Partial<Record<SendRefusal, string>>;

/**
 * Which page a read-only frame — the history view's (§15.4) — shows: an
 * earlier one, or the current one shown there rather than in canvas view.
 */
export type CanvasReadOnly = "earlier" | "current";

/** `readonly`'s two wordings, by the page the frame shows (§8.2). */
export const READONLY_REFUSAL_MESSAGES = {
	earlier: "This is an earlier version of the canvas; it cannot send.",
	current: "This page is shown in history; close history to use it.",
} as const satisfies Record<CanvasReadOnly, string>;

const SEND = "pockode:canvas-send";
const PATCHED = "pockode:canvas-patched";
const FOCUS = "pockode:canvas-focus";
const READY = "pockode:canvas-ready";
const SEND_RESULT = "pockode:canvas-send-result";
const PATCH = "pockode:canvas-patch";
const THEME = "pockode:canvas-theme";
const SENDABLE = "pockode:canvas-sendable";

/** What the bridge posts. Untrusted: the page's own scripts can post it too. */
export type CanvasPageMessage =
	| { type: typeof SEND; id: string; action: string; data: unknown }
	| { type: typeof PATCHED; revision: number; ok: boolean }
	| { type: typeof FOCUS; editable: boolean }
	| { type: typeof READY };

/** What the app posts to the page's window. */
export type CanvasAppMessage =
	| { type: typeof SEND_RESULT; id: string; ok: true }
	| {
			type: typeof SEND_RESULT;
			id: string;
			ok: false;
			code: SendRefusal;
			message: string;
	  }
	| {
			type: typeof PATCH;
			from_revision: number;
			revision: number;
			ops: CanvasOp[];
	  }
	| ({ type: typeof THEME } & CanvasTheme)
	| { type: typeof SENDABLE; sendable: boolean; reason?: "permission" };

/** `data` if it is a message the bridge sends, else null. */
export function readCanvasPageMessage(data: unknown): CanvasPageMessage | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	switch (message.type) {
		case SEND:
			return typeof message.id === "string" &&
				typeof message.action === "string" &&
				message.action !== "" &&
				"data" in message
				? {
						type: SEND,
						id: message.id,
						action: message.action,
						data: message.data,
					}
				: null;
		case PATCHED:
			return typeof message.revision === "number" &&
				typeof message.ok === "boolean"
				? { type: PATCHED, revision: message.revision, ok: message.ok }
				: null;
		case FOCUS:
			return typeof message.editable === "boolean"
				? { type: FOCUS, editable: message.editable }
				: null;
		case READY:
			return { type: READY };
		default:
			return null;
	}
}

/**
 * Each `--pk-*` variable a page may use and the app token it takes its value
 * from (§3.3). The names are a promise to every page ever drawn: add one only
 * deliberately, and never rename or remove one.
 */
export const CANVAS_THEME_TOKENS = {
	"--pk-bg": "--th-bg-primary",
	"--pk-bg-secondary": "--th-bg-secondary",
	"--pk-bg-tertiary": "--th-bg-tertiary",
	"--pk-text": "--th-text-primary",
	"--pk-text-secondary": "--th-text-secondary",
	"--pk-text-muted": "--th-text-muted",
	"--pk-border": "--th-border",
	"--pk-accent": "--th-accent",
	"--pk-accent-text": "--th-accent-text",
	"--pk-success": "--th-success",
	"--pk-error": "--th-error",
	"--pk-warning": "--th-warning",
	"--pk-code-bg": "--th-code-bg",
	"--pk-code-text": "--th-code-text",
} as const;

export type CanvasThemeVar = keyof typeof CANVAS_THEME_TOKENS;

export interface CanvasTheme {
	scheme: "light" | "dark";
	vars: Partial<Record<CanvasThemeVar, string>>;
}

const THEME_VARS = Object.keys(CANVAS_THEME_TOKENS) as CanvasThemeVar[];

/** The theme as `style` — the app's computed root style — holds it now. */
export function canvasThemeFrom(
	style: CSSStyleDeclaration,
	scheme: CanvasTheme["scheme"],
): CanvasTheme {
	const vars: CanvasTheme["vars"] = {};
	for (const name of THEME_VARS) {
		const value = style.getPropertyValue(CANVAS_THEME_TOKENS[name]).trim();
		if (value) vars[name] = value;
	}
	return { scheme, vars };
}

/** The base stylesheet's attribute, by which the bridge finds it to rewrite. */
const BASE_ATTRIBUTE = "data-pockode-canvas-base";

/**
 * What the root gets beside the variables: the theme applied, or a dark page
 * would start as black text on a dark canvas, and the accent on the controls
 * the rules below leave native (checkboxes, radios, ranges).
 */
const ROOT_CSS =
	"background:var(--pk-bg);color:var(--pk-text);accent-color:var(--pk-accent)";

/** The inputs that are a box holding text or a press, not a native widget. */
const BOXED_INPUT =
	"input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=hidden],[type=image])";
const BOXED = `button,${BOXED_INPUT},select,textarea`;
const CONTROL = "button,input,select,textarea";

/**
 * The cascade layer the whole base stylesheet is in. Zero specificity alone
 * would lose to every agent rule in a layer — Tailwind's browser build and
 * Pico put all of theirs in one — since unlayered rules beat layered ones; a
 * layer named first in the document is below every other, and below every
 * unlayered rule.
 */
const LAYER = "pockode-base";

/**
 * The theme-independent half of the base stylesheet. Every selector is also
 * wholly inside `:where()`, pseudo-classes included, so each rule weighs
 * nothing (§3.3). Order matters among them for that reason: the accent and the
 * dimming come after the fill they override. A
 * `type="button"` or `reset` button in a sending form is no send, so it keeps
 * the plain fill.
 */
const STATIC_CSS = [
	`:where(${CONTROL}){font:inherit}`,
	`:where(${BOXED}){box-sizing:border-box;color:inherit;background:var(--pk-bg-secondary);border:1px solid var(--pk-border);border-radius:6px;padding:.375em .75em}`,
	`:where(button[data-pk-send],form[data-pk-send] :is(button:not([type=button],[type=reset]),input[type=submit])){background:var(--pk-accent);border-color:var(--pk-accent);color:var(--pk-accent-text)}`,
	`:where(:is(${CONTROL}):focus-visible){outline:2px solid var(--pk-accent);outline-offset:1px}`,
	`:where(:is(${CONTROL}):disabled){opacity:.5;cursor:not-allowed}`,
	// The coarse-pointer hit-area floor (docs/responsive-ui.md).
	`@media (pointer:coarse){:where(${BOXED}){min-height:44px}}`,
].join("");

/**
 * The whole base stylesheet for `theme`. The bridge builds the same text when
 * the theme changes (`themeCss` in the script); a test holds the two equal.
 */
export function canvasBaseCss(theme: CanvasTheme): string {
	let declarations = `color-scheme:${theme.scheme === "dark" ? "dark" : "light"}`;
	for (const name of THEME_VARS) {
		const value = theme.vars[name];
		if (typeof value === "string") declarations += `;${name}:${value}`;
	}
	return `@layer ${LAYER}{:where(:root){${declarations};${ROOT_CSS}}${STATIC_CSS}}`;
}

/**
 * The base stylesheet as markup, for the page document right before the
 * agent's own. A `<` cannot end the element: it is written as the CSS escape
 * it means.
 */
export function canvasBaseStylesheet(theme: CanvasTheme): string {
	return `<style ${BASE_ATTRIBUTE}>${canvasBaseCss(theme).replace(/</g, "\\3c ")}</style>`;
}

/**
 * The bridge (§8.1), to run in the page before the agent's markup. `target` is
 * a script expression for the app's window — `parent.parent` past the
 * wrapper; the bridge posts only there and takes a message only from it.
 *
 * Kept in plain old JavaScript with no `</` anywhere, since it is inlined into
 * a `<script>` of a `srcdoc`.
 *
 * What it does, by gesture (the precedence of §6.1):
 *
 * - a click sends for the nearest `[data-pk-send]` around the target, unless
 *   that is a form (its submit sends) or a field (Enter sends, a click
 *   nothing), or the click is on a field or label inside it — a card that
 *   sends may hold a checkbox, which must still toggle; a disabled element
 *   sends nothing;
 * - a submit of a `form[data-pk-send]` sends the form's action; the submit of
 *   one whose button carries its own action never happens, the click having
 *   prevented it;
 * - any other submit nobody cancelled is cancelled, once every handler of the
 *   page's own has run — but a dialog's (`method="dialog"`), which only
 *   closes its dialog: Chromium's `form-action` does not cover `about:srcdoc`,
 *   so a plain form would reload the page into itself and lose what was typed.
 *   The policy's `form-action 'none'` still holds every other destination;
 *   this covers only the gap, and both have to stay. Never claimed: the page
 *   still hears the event, and a handler that cancels it first wins. Out of
 *   its reach, so losing the page in Chromium (a plain form reloads it into
 *   itself, one to another host leaves it): a submit whose propagation a page
 *   handler stops before the window (React's `onSubmit` with
 *   `stopPropagation()`), and `form.submit()`, which fires no event;
 * - Enter in an `input[data-pk-send]` sends the input's action and prevents
 *   the implicit submit, except while an input method composes (Safari ends a
 *   composition with a keydown that is no longer `isComposing` but still
 *   carries keyCode 229), and except a held key's repeats;
 * - Enter in another text field of a `form[data-pk-send]` submits the form.
 *   The browser does that itself through the form's first submit button,
 *   unless there is none, or that button carries an action of its own — which
 *   its synthetic click would send instead — so there the bridge submits the
 *   form, with no submitter.
 *
 * A well-formed send is never refused here, not even while the app has said
 * the page cannot send: the app refuses it, because each refused attempt is
 * something it shows (§10.3). Only a call that cannot be posted — no action
 * name, data that is not JSON — is refused here, with `invalid`.
 *
 * A patch is tried first on a copy of the page in a document of its own, which
 * loads and runs nothing, and the live page is touched only once every op has
 * applied there: a patch that fails leaves the page as it was and runs nothing
 * — no script, no `onerror` of an image that was briefly in the page. On the
 * live page its HTML is parsed in the live document, where scripting is on as
 * for the page's own parse and the server's, so a `<noscript>` holds text.
 *
 * Its scripts then run, re-created since `innerHTML` alone leaves them inert,
 * in document order, through one queue for all patches: a `src` script the
 * engine will fetch as JavaScript, without `async`, holds back every script
 * after it — this patch's and the next one's — until it has loaded or failed,
 * as the parser would. One it will not fetch (`nomodule`, a template `type`)
 * fires neither, so it holds nothing back.
 *
 * It says it is ready once the page is parsed — its regions are there to
 * patch — without waiting for what the page loads, and again whenever the page
 * is loaded anew, a reload of its own included.
 */
export function canvasBridgeScript(target: string): string {
	const script = `(function(){
var app=${target};
var NAMES=${JSON.stringify(THEME_VARS)};
var ROOT_CSS=${JSON.stringify(ROOT_CSS)};
var LAYER=${JSON.stringify(LAYER)};
var STATIC_CSS=${JSON.stringify(STATIC_CSS)};
var TEXT_TYPES=["text","search","url","tel","email","password","number"];
var pending=Object.create(null);
// Per document: a page that reloads itself keeps its window, and an answer
// still coming for the old document's send must not settle the new one's.
var ID_PREFIX="pk"+Math.random().toString(36).slice(2)+"-";
var next=0;
var editable=false;
var baseStyle=null;
function noop(){}
function post(m){app.postMessage(m,"*");}
function refusal(code,message){var e=new Error(message);e.code=code;return e;}
function send(action,data){
  return new Promise(function(resolve,reject){
    if(typeof action!=="string"||action===""){
      reject(refusal("invalid","pockode.send needs an action name, a non-empty string: for example pockode.send('save', data)."));
      return;
    }
    var json;
    try{json=JSON.stringify(data===undefined?{}:data);}
    catch(x){
      reject(refusal("invalid","The data of '"+action+"' cannot be sent as JSON: "+(x&&x.message?x.message:String(x))));
      return;
    }
    if(json===undefined){
      reject(refusal("invalid","The data of '"+action+"' cannot be sent as JSON: pass an object, an array, a string, a number, a boolean or null."));
      return;
    }
    var id=ID_PREFIX+(++next);
    pending[id]={resolve:resolve,reject:reject};
    post({type:"${SEND}",id:id,action:action,data:JSON.parse(json)});
  });
}
function fields(form,extra){
  var out=Object.create(null);
  function add(k,v){
    if(!(k in out))out[k]=v;
    else if(Array.isArray(out[k]))out[k].push(v);
    else out[k]=[out[k],v];
  }
  if(form)new FormData(form).forEach(function(v,k){if(typeof v==="string")add(k,v);});
  if(extra)add(extra.name,extra.value);
  return out;
}
function own(el){
  var name=el.getAttribute("name");
  if(!name)return null;
  return {name:name,value:typeof el.value==="string"?el.value:(el.getAttribute("value")||"")};
}
document.addEventListener("click",function(e){
  var t=e.target;
  var el=t&&t.closest?t.closest("[data-pk-send]"):null;
  if(!el)return;
  var tag=el.localName;
  if(tag==="form"||tag==="input"||tag==="select"||tag==="textarea")return;
  var field=t.closest("input,select,textarea,label");
  if(field&&field!==el&&el.contains(field))return;
  if(el.matches(":disabled"))return;
  var action=el.getAttribute("data-pk-send");
  if(!action)return;
  e.preventDefault();
  var form=el.form!==undefined?el.form:el.closest("form");
  send(action,fields(form,own(el))).catch(noop);
},true);
document.addEventListener("submit",function(e){
  var form=e.target;
  if(!form||form.localName!=="form"||!form.hasAttribute("data-pk-send"))return;
  e.preventDefault();
  var action=form.getAttribute("data-pk-send");
  if(!action)return;
  send(action,fields(form,e.submitter?own(e.submitter):null)).catch(noop);
},true);
// Taken off and added again on the way down, so it is the window's last
// bubbling listener, after any the page added itself, and never there twice.
function cancelUnhandled(e){
  removeEventListener("submit",cancelUnhandled);
  if(!e.defaultPrevented)e.preventDefault();
}
addEventListener("submit",function(e){
  removeEventListener("submit",cancelUnhandled);
  // Attributes, not form.method, which a field named "method" shadows.
  var by=e.submitter,t=e.target;
  var method=by&&by.hasAttribute("formmethod")?by.getAttribute("formmethod"):t.getAttribute?t.getAttribute("method"):null;
  if(String(method).toLowerCase()==="dialog")return;
  addEventListener("submit",cancelUnhandled);
},true);
document.addEventListener("keydown",function(e){
  if(e.key!=="Enter"||e.isComposing||e.keyCode===229)return;
  var t=e.target;
  if(!t||t.localName!=="input")return;
  if(!t.hasAttribute("data-pk-send")){
    var form=t.form;
    if(!form||!form.hasAttribute("data-pk-send")||TEXT_TYPES.indexOf(t.type)<0)return;
    var by=defaultButton(form);
    if(by&&(by.disabled||by.closest("[data-pk-send]")===form))return;
    e.preventDefault();
    if(e.repeat)return;
    if(form.requestSubmit)form.requestSubmit();
    else send(form.getAttribute("data-pk-send"),fields(form,null)).catch(noop);
    return;
  }
  e.preventDefault();
  var action=t.getAttribute("data-pk-send");
  if(e.repeat||t.disabled||!action)return;
  var value=t.value;
  var data=Object.create(null);
  data[t.getAttribute("name")||"value"]=value;
  send(action,data).then(function(){
    if(t.value!==value)return;
    t.value="";
    t.dispatchEvent(new Event("input",{bubbles:true}));
  },noop);
},true);
function defaultButton(form){
  for(var i=0;i<form.elements.length;i++){
    var el=form.elements[i];
    if((el.localName==="button"||el.localName==="input")&&(el.type==="submit"||el.type==="image"))return el;
  }
  return null;
}
function isEditable(el){
  if(!el||el.nodeType!==1)return false;
  if(el.isContentEditable)return true;
  var tag=el.localName;
  if(tag==="select")return !el.disabled;
  if(tag==="textarea")return !el.disabled&&!el.readOnly;
  if(tag==="input")return TEXT_TYPES.indexOf(el.type)>=0&&!el.disabled&&!el.readOnly;
  return false;
}
function report(now){
  if(now===editable)return;
  editable=now;
  post({type:"${FOCUS}",editable:now});
}
document.addEventListener("focusin",function(e){report(isEditable(e.target));},true);
document.addEventListener("focusout",function(e){report(isEditable(e.relatedTarget));},true);
function region(root,name){
  var all=root.querySelectorAll("[data-pk-region]");
  // Inside a noscript only in the trial copy, which parses with scripting
  // off; the page and the server read its contents as text.
  for(var i=0;i<all.length;i++)if(all[i].getAttribute("data-pk-region")===name&&!all[i].closest("noscript"))return all[i];
  return null;
}
function parse(el,html){
  var box=el.ownerDocument.createElementNS(el.namespaceURI,el.localName);
  box.innerHTML=html;
  return Array.prototype.slice.call(box.childNodes);
}
function apply(root,ops,inserted){
  for(var i=0;i<ops.length;i++){
    var op=ops[i];
    if(!op||typeof op.region!=="string")throw new Error("malformed op");
    var el=region(root,op.region);
    if(!el)throw new Error("no region "+op.region);
    if(op.op==="remove"){
      el.remove();
      continue;
    }
    if(typeof op.html!=="string"||(op.op!=="replace"&&op.op!=="append"))throw new Error("malformed op");
    var nodes=parse(el,op.html);
    if(op.op==="replace")el.replaceChildren.apply(el,nodes);
    else el.append.apply(el,nodes);
    inserted.push.apply(inserted,nodes);
  }
}
var JS_TYPE=new RegExp("^((text|application)/(x-)?(java|ecma)script|module)?$");
function blocks(s){
  return "async" in s&&s.hasAttribute("src")&&!s.hasAttribute("async")&&!s.hasAttribute("nomodule")&&JS_TYPE.test((s.getAttribute("type")||"").trim().toLowerCase());
}
var queue=[];
var waiting=false;
function drain(){
  while(!waiting&&queue.length){
    var old=queue.shift();
    if(!old.isConnected)continue;
    var s=document.createElementNS(old.namespaceURI,"script");
    for(var j=0;j<old.attributes.length;j++){
      var a=old.attributes[j];
      s.setAttributeNS(a.namespaceURI,a.name,a.value);
    }
    s.textContent=old.textContent;
    if(blocks(s)){
      waiting=true;
      s.addEventListener("load",resume);
      s.addEventListener("error",resume);
    }
    old.replaceWith(s);
  }
}
function resume(){
  waiting=false;
  drain();
}
function run(nodes){
  var scripts=[];
  nodes.forEach(function(n){
    if(n.nodeType!==1)return;
    if(n.localName==="script")scripts.push(n);
    scripts.push.apply(scripts,Array.prototype.slice.call(n.getElementsByTagName("script")));
  });
  scripts.sort(function(a,b){return a===b?0:a.compareDocumentPosition(b)&4?-1:1;});
  queue.push.apply(queue,scripts);
  drain();
}
function patch(d){
  var inserted=[],ok=Array.isArray(d.ops);
  try{
    if(ok){
      var copy=document.implementation.createHTMLDocument("");
      copy.replaceChild(copy.importNode(document.documentElement,true),copy.documentElement);
      apply(copy,d.ops,[]);
    }
  }catch(x){ok=false;}
  // The copy took the ops, so the page can only refuse them through
  // something no copy has — a custom element's own code; the app then draws
  // the revision whole.
  if(ok)try{
    apply(document,d.ops,inserted);
    run(inserted);
  }catch(x){ok=false;}
  report(isEditable(document.activeElement));
  post({type:"${PATCHED}",revision:d.revision,ok:ok});
}
function themeCss(scheme,vars){
  var decl="color-scheme:"+(scheme==="dark"?"dark":"light");
  NAMES.forEach(function(n){if(typeof vars[n]==="string")decl+=";"+n+":"+vars[n];});
  return "@layer "+LAYER+"{:where(:root){"+decl+";"+ROOT_CSS+"}"+STATIC_CSS+"}";
}
function theme(d){
  if(!baseStyle)baseStyle=document.querySelector("style[${BASE_ATTRIBUTE}]");
  if(baseStyle)baseStyle.textContent=themeCss(d.scheme,d.vars&&typeof d.vars==="object"?d.vars:{});
}
function sendable(d){
  var root=document.documentElement;
  if(d.sendable)root.removeAttribute("data-pk-blocked");
  else root.setAttribute("data-pk-blocked",typeof d.reason==="string"?d.reason:"");
}
addEventListener("message",function(e){
  var d=e.data;
  if(e.source!==app||!d||typeof d!=="object")return;
  if(d.type==="${SEND_RESULT}"){
    var p=pending[d.id];
    if(!p)return;
    delete pending[d.id];
    if(d.ok===true)p.resolve();
    else p.reject(refusal(typeof d.code==="string"?d.code:"failed",typeof d.message==="string"?d.message:"The action was not sent."));
  }else if(d.type==="${PATCH}")patch(d);
  else if(d.type==="${THEME}")theme(d);
  else if(d.type==="${SENDABLE}")sendable(d);
});
window.pockode={send:send};
function ready(){post({type:"${READY}"});}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready);
else ready();
})();`;
	return `<script>${script}</script>`;
}
