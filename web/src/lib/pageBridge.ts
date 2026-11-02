/**
 * The page side of the bridge between an agent's page and the app
 * (docs/tool-call-ui.md § Sending to the agent): the script injected into a
 * page that sends or follows the theme (`pageTheme.ts`), and the messages the
 * two exchange. Ported from the canvas branch's `canvasBridge.ts`, whose send
 * contract it keeps (docs/canvas-ui.md §6.1 there). `HtmlFrame` is the app
 * side.
 */

import {
	BASE_ATTRIBUTE,
	LAYER,
	NATIVE_SEND,
	PAGE_READY,
	PAGE_THEME,
	PAGE_THEME_VARS,
	PAGE_THEMED,
	ROOT_CSS,
	STATIC_CSS,
} from "./pageTheme";

export type SendRefusal =
	| "inactive"
	| "readonly"
	| "awaiting"
	| "offline"
	| "invalid"
	| "failed";

/**
 * The words of the refusals the app decides itself; `invalid` and `failed`
 * carry the bridge's or the server's own.
 */
export const SEND_REFUSAL_MESSAGES = {
	inactive:
		"Nothing was sent: this page sends only after you have pressed or typed in it.",
	readonly: "This session is read-only here.",
	awaiting: "Answer the permission request first.",
	offline: "Not connected — try again when the connection is back.",
} as const satisfies Partial<Record<SendRefusal, string>>;

/**
 * Whether a page sends: its HTML, as stored, names the bridge. Read from the
 * source rather than from what its scripts do, so it is decided before the
 * frame is drawn — a page that reaches the function some other way
 * (`window["pock" + "ode"]`) is not seen, and the tool descriptions say to
 * write it plainly.
 */
export function sendsToAgent(html: string): boolean {
	return html.includes("data-pk-send") || html.includes("pockode.send");
}

const SEND = "pockode:page-send";
const SEND_RESULT = "pockode:page-send-result";

/** What the bridge posts. Untrusted: the page's own scripts can post it too. */
export interface PageSendMessage {
	type: typeof SEND;
	id: string;
	action: string;
	data: unknown;
	/** Whether the reader had used the page's document when it sent. */
	active: boolean;
}

/** What the app answers every send with. */
export type PageSendResult =
	| { type: typeof SEND_RESULT; id: string; ok: true }
	| {
			type: typeof SEND_RESULT;
			id: string;
			ok: false;
			code: SendRefusal;
			message: string;
	  };

/** `data` if it is a send the bridge posts, else null. */
export function readPageSend(data: unknown): PageSendMessage | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	return message.type === SEND &&
		typeof message.id === "string" &&
		typeof message.action === "string" &&
		message.action !== "" &&
		"data" in message &&
		typeof message.active === "boolean"
		? {
				type: SEND,
				id: message.id,
				action: message.action,
				data: message.data,
				active: message.active,
			}
		: null;
}

export function sendAccepted(id: string): PageSendResult {
	return { type: SEND_RESULT, id, ok: true };
}

export function sendRefused(
	id: string,
	code: SendRefusal,
	message: string,
): PageSendResult {
	return { type: SEND_RESULT, id, ok: false, code, message };
}

/**
 * The bridge, to run in a page that sends or follows the theme, after the
 * reporter and before the base stylesheet and the agent's markup. `target` is
 * a script expression for the app's window — `parent.parent` past the
 * wrapper; the bridge posts only there and takes a message only from it.
 *
 * Kept in plain old JavaScript with no `</` anywhere, since it is inlined into
 * a `<script>` of a `srcdoc`.
 *
 * In every such page it says `pockode:page-ready` once the page is parsed —
 * with the scheme it is in, in a page that follows the theme, which then also
 * applies each `pockode:page-theme` the app posts (`themePart`). Only a page
 * that sends gets `pockode.send` and the gestures below.
 *
 * What a page that sends does, by gesture (the canvas's precedence):
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
 *   its reach (docs/tool-call-ui.md § Forms in a page): a submit whose
 *   propagation a page handler stops before the window, and `form.submit()`,
 *   which fires no event;
 * - Enter in an `input[data-pk-send]` sends the input's action and prevents
 *   the implicit submit, except while an input method composes (Safari ends a
 *   composition with a keydown that is no longer `isComposing` but still
 *   carries keyCode 229), and except a held key's repeats;
 * - Enter in another text field of a `form[data-pk-send]` submits the form.
 *   The browser does that itself through the form's first submit button,
 *   unless there is none, or that button carries an action of its own — which
 *   its synthetic click would send instead — so there the bridge submits the
 *   form, with no submitter;
 * - any other element that sends is a button, by the WAI-ARIA button pattern:
 *   a `role` and a tab stop, unless the page gave it its own, and Enter (on
 *   press) or Space (on release) on it clicks it. That holds for what the
 *   page's scripts add or change later, and is taken back from an element
 *   that stops sending.
 *
 * Every send carries `active`: whether the reader has used this document —
 * `navigator.userActivation.hasBeenActive`, or, in an engine without it, a
 * trusted `pointerdown` or `keydown` the bridge saw — not a `pointerup` or
 * `touchend`, which end a scroll over the page as much as a press. The app
 * refuses an inactive one; the bridge does not, so that every refusal is the
 * app's to show. Only a call
 * that cannot be posted — no action name, data that is not JSON — is refused
 * here, with `invalid`.
 */
export function pageBridgeScript(
	target: string,
	{ sends, themed }: { sends: boolean; themed: boolean },
): string {
	const script = `(function(){
var app=${target};
function post(m){app.postMessage(m,"*");}
${sends ? sendPart() : ""}${themed ? themePart() : ""}addEventListener("message",function(e){
  var d=e.data;
  if(e.source!==app||!d||typeof d!=="object")return;
  ${sends ? `if(d.type==="${SEND_RESULT}")settle(d);` : ""}${themed ? `if(d.type==="${PAGE_THEME}")theme(d);` : ""}
});
// Once parsed; with the send, it also makes buttons of what was parsed before
// the bridge ran.
function ready(){${sends ? "makeAll(document.documentElement);" : ""}post({type:"${PAGE_READY}"${themed ? ",scheme:scheme()" : ""}});}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready);
else ready();
})();`;
	return `<script>${script}</script>`;
}

/**
 * What a page that follows the theme runs: the theme the app posts rewrites
 * the base stylesheet's text — never an inline style on the root, which would
 * outrank the agent's own `:root { --pk-…: … }` — and is answered with the
 * scheme now in force, which the page was drawn in until then.
 */
function themePart(): string {
	return `var LAYER=${JSON.stringify(LAYER)},ROOT_CSS=${JSON.stringify(ROOT_CSS)},STATIC_CSS=${JSON.stringify(STATIC_CSS)};
var NAMES=${JSON.stringify(PAGE_THEME_VARS)};
// Found once parsed: the base stylesheet comes after the bridge.
var baseStyle=null;
function baseOf(){
  if(!baseStyle)baseStyle=document.querySelector("style[${BASE_ATTRIBUTE}]");
  return baseStyle;
}
function schemeOf(s){return s==="dark"?"dark":"light";}
function scheme(){
  var el=baseOf();
  return schemeOf(el?el.getAttribute("${BASE_ATTRIBUTE}"):null);
}
function themeCss(s,vars){
  var decl="color-scheme:"+s;
  NAMES.forEach(function(n){if(typeof vars[n]==="string")decl+=";"+n+":"+vars[n];});
  return "@layer "+LAYER+"{:where(:root){"+decl+";"+ROOT_CSS+"}"+STATIC_CSS+"}";
}
function theme(d){
  var el=baseOf();
  if(!el)return;
  var s=schemeOf(d.scheme);
  el.setAttribute("${BASE_ATTRIBUTE}",s);
  el.textContent=themeCss(s,d.vars&&typeof d.vars==="object"?d.vars:{});
  post({type:"${PAGE_THEMED}",scheme:s});
}
`;
}

/** What a page that sends runs: `pockode.send` and the markup's gestures. */
function sendPart(): string {
	return `var NATIVE_SEND=${JSON.stringify(NATIVE_SEND)};
var TEXT_TYPES=["text","search","url","tel","email","password","number"];
var pending=Object.create(null);
// Per document: a page that reloads itself keeps its window, and an answer
// still coming for the old document's send must not settle the new one's.
var ID_PREFIX="pk"+Math.random().toString(36).slice(2)+"-";
var next=0;
var used=false;
// First, so a key that sends has already counted when its own handler runs.
["pointerdown","keydown"].forEach(function(t){
  addEventListener(t,function(e){if(e.isTrusted)used=true;},true);
});
function active(){
  var u=navigator.userActivation;
  return u&&typeof u.hasBeenActive==="boolean"?u.hasBeenActive:used;
}
function noop(){}
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
    pending[id]={resolve:resolve,reject:reject,action:action};
    post({type:"${SEND}",id:id,action:action,data:JSON.parse(json),active:active()});
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
// What the bridge itself put on each element it made a button of, so that it
// takes back only that once the element stops sending.
var made=new WeakMap();
function pressable(el){
  return !!el.getAttribute("data-pk-send")&&!el.matches(NATIVE_SEND);
}
function make(el){
  var mine=made.get(el);
  if(pressable(el)){
    if(mine)return;
    mine={role:!el.hasAttribute("role"),tab:!el.hasAttribute("tabindex")};
    if(mine.role)el.setAttribute("role","button");
    if(mine.tab)el.setAttribute("tabindex","0");
    made.set(el,mine);
  }else if(mine){
    made.delete(el);
    if(mine.role&&el.getAttribute("role")==="button")el.removeAttribute("role");
    if(mine.tab&&el.getAttribute("tabindex")==="0")el.removeAttribute("tabindex");
  }
}
function makeAll(node){
  if(node.nodeType!==1)return;
  if(node.hasAttribute("data-pk-send"))make(node);
  var all=node.querySelectorAll("[data-pk-send]");
  for(var i=0;i<all.length;i++)make(all[i]);
}
// From before the agent's markup is parsed, so the parser's insertions are
// seen too, as are the page's own scripts'.
new MutationObserver(function(records){
  records.forEach(function(r){
    if(r.type==="attributes")make(r.target);
    else for(var i=0;i<r.addedNodes.length;i++)makeAll(r.addedNodes[i]);
  });
}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:["data-pk-send","href"]});
// The button pattern's keys, on the element itself — not a field inside it.
// In the bubble phase, so a key the page's own handler took is left to it.
// Each presses by a click, as on a native button: the page's click handlers
// see it, and the click sends. An SVG or MathML element has no click() of
// its own, so it is dispatched.
function press(el){
  if(typeof el.click==="function")el.click();
  else el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,composed:true,view:window}));
}
var spaceOn=null;
document.addEventListener("keydown",function(e){
  var t=e.target;
  if(e.defaultPrevented||e.isComposing||!t||!made.has(t)||t.isContentEditable)return;
  if(e.key==="Enter"){
    e.preventDefault();
    if(!e.repeat)press(t);
  }else if(e.key===" "){
    // Space presses on release, and not when focus has left before it.
    e.preventDefault();
    if(!e.repeat)spaceOn=t;
  }
});
document.addEventListener("keyup",function(e){
  if(e.key!==" ")return;
  var on=spaceOn;
  spaceOn=null;
  if(!on||on!==e.target||e.defaultPrevented||!made.has(on))return;
  e.preventDefault();
  press(on);
});
document.addEventListener("focusout",function(){spaceOn=null;},true);
function settle(d){
  var p=pending[d.id];
  if(!p)return;
  delete pending[d.id];
  if(d.ok===true){p.resolve();return;}
  var code=typeof d.code==="string"?d.code:"failed";
  var message=typeof d.message==="string"?d.message:"The action was not sent.";
  // For whoever wrote the page: a send on load is the usual mistake, and
  // nothing else in the frame would say why it did nothing.
  if(code==="inactive")console.warn("pockode.send('"+p.action+"'): "+message);
  p.reject(refusal(code,message));
}
window.pockode={send:send};
`;
}
