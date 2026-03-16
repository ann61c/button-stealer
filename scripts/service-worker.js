const MAXIMUM = 'maximum';
const CNTFL_MGMT_API_KEY = 'contentManagementApiKey';
const CNTFL_DLVR_API_KEY = 'contentDeliveryApiKey';
const CNTFL_SPACE_ID = 'spaceId';
const CNTFL_TYPE_ID = 'contentTypeId';
const CONTENTFUL = 'contentful';
const IGNORE = 'ignore';
const BUTTONS = 'buttons';
const UPLOAD = 'upload';
const OFFSCREEN_DOCUMENT_PATH = '/offscreen/offscreen.html';
let isDark = false;

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Cross-browser: chrome.action (MV3) vs chrome.browserAction (MV2/Firefox)
const browserAction = browserAPI.action || browserAPI.browserAction;

// Feature-detect: is the offscreen API available? (Chrome only)
const hasOffscreenAPI = typeof browserAPI.offscreen !== 'undefined';

browserAPI.runtime.onInstalled.addListener(async ({ reason }) => {
    switch (reason) {
        case 'install':
            browserAPI.storage.local.set({
                buttons: [],
                upload: [],
                ignore: [],
                maximum: 200,
                contentful: {
                    contentManagementApiKey: '',
                    contentDeliveryApiKey: '',
                    spaceId: '',
                    contentTypeId: ''
                }
            });
            break;
        case 'update':
            const { buttons, upload, contentful } = await browserAPI.storage.local.get([BUTTONS, UPLOAD, CONTENTFUL]);
            if (buttons.length === 0) break;
            let counter = buttons.length - 1;
            buttons.map(button => { button.id = counter--; button.hidden = button.hidden ?? false; } );
            browserAPI.storage.local.set({ buttons: buttons });
            if (!upload) browserAPI.storage.local.set({ 'upload': [] });
            if (!contentful.contentDeliveryApiKey) {
                contentful.contentDeliveryApiKey = '';
                browserAPI.storage.local.set({ 'contentful': contentful });
            }
            break;
        default:
            break;
    }
});

browserAPI.storage.onChanged.addListener(async (obj) => {
    switch (true) {
        case obj.hasOwnProperty(MAXIMUM):
            const { buttons } = await browserAPI.storage.local.get(BUTTONS);
            while (buttons.length >= obj.maximum.newValue) buttons.pop();
            browserAPI.storage.local.set({ 'buttons': buttons });
            break;
        case obj.hasOwnProperty(UPLOAD):
            uploadOffscreen();
            break;
        case obj.hasOwnProperty(CONTENTFUL):
            uploadOffscreen();
            break;
        default:
            break;
    }
});

// ── Firefox-only: inline Contentful upload/remove/sync ───────────────
// When running as a background page (Firefox), the Contentful libraries
// are loaded via background.html, so createClient and contentful are
// available as globals.

const ffUpload = async (button, cntfl) => {
    const client = createClient({ accessToken: cntfl[CNTFL_MGMT_API_KEY] });
    let error = false;
    await client.getSpace(cntfl[CNTFL_SPACE_ID])
        .then(space => space.getEnvironment('master'))
        .then(env => env.createEntry(cntfl[CNTFL_TYPE_ID], {
            fields: {
                name: { 'en-US': button.name },
                code: { 'en-US': button.code },
                source: { 'en-US': button.source },
                text: { 'en-US': button.text }
            }
        }))
        .then(entry => entry.publish())
        .then(entry => console.log(`Entry ${entry.sys.id} published.`))
        .catch(e => { console.log(e.message); error = true; })
        .finally(() => { if (!error) ffSendDone(); });
};

const ffFind = async (name, cntfl) => {
    const client = contentful.createClient({
        accessToken: cntfl[CNTFL_DLVR_API_KEY],
        space: cntfl[CNTFL_SPACE_ID]
    });
    const entries = await client.getEntries({
        content_type: cntfl[CNTFL_TYPE_ID],
        select: 'sys.createdAt',
        order: '-sys.createdAt',
        locale: 'en-US',
        'fields.name[match]': name
    });
    return entries.items.map(entry => entry.sys.id);
};

const ffRemove = async (button, cntfl) => {
    const ids = await ffFind(button.name, cntfl);
    if (ids.length === 0) { ffSendDone(); return; }
    const client = createClient({ accessToken: cntfl[CNTFL_MGMT_API_KEY] });
    let error = false;
    await client.getSpace(cntfl[CNTFL_SPACE_ID])
        .then(space => space.getEnvironment('master'))
        .then(env => env.getEntry(ids[0]))
        .then(entry => entry.unpublish())
        .then(entry => entry.delete())
        .then(() => console.log('Entry deleted.'))
        .catch(e => { console.log(e.message); error = true; })
        .finally(() => { if (!error) ffSendDone(); });
};

const ffSync = async (cntfl) => {
    const client = contentful.createClient({
        accessToken: cntfl[CNTFL_DLVR_API_KEY],
        space: cntfl[CNTFL_SPACE_ID]
    });
    const allButtons = [];
    let skip = 0, total = Infinity;
    while (skip < total) {
        const entries = await client.getEntries({
            content_type: cntfl[CNTFL_TYPE_ID],
            locale: 'en-US',
            order: '-sys.createdAt',
            select: 'fields, sys.createdAt',
            skip: skip
        });
        total = entries.total;
        skip += entries.limit;
        allButtons.push(...entries.items);
    }
    const value = allButtons.map((b, i) => ({
        id: allButtons.length - i - 1,
        name: b.fields.name,
        code: b.fields.code,
        source: b.fields.source,
        text: b.fields.text,
        stolenAt: b.sys.createdAt,
    }));
    browserAPI.storage.local.set({ buttons: value });
};

const ffSendDone = async () => {
    const { upload } = await browserAPI.storage.local.get(UPLOAD);
    upload.pop();
    browserAPI.runtime.sendMessage({ type: 'full-refresh', target: 'stolen-buttons' });
    browserAPI.storage.local.set({ 'upload': upload });
};

// ── Upload dispatcher (Chrome offscreen vs Firefox inline) ───────────

const uploadOffscreen = async () => {
    const { upload, contentful } = await browserAPI.storage.local.get([UPLOAD, CONTENTFUL]);
    if (!(contentful[CNTFL_MGMT_API_KEY] && contentful[CNTFL_DLVR_API_KEY] && contentful[CNTFL_SPACE_ID] && contentful[CNTFL_TYPE_ID])) {
        if (upload.length > 0) browserAPI.storage.local.set({ 'upload': [] });
        return;
    }
    if (upload.length === 0) {
        if (hasOffscreenAPI) {
            browserAPI.runtime.sendMessage({
                type: 'full-sync',
                target: 'offscreen',
                contentful: contentful
            });
        } else {
            ffSync(contentful);
        }
        return;
    }

    const button = upload[upload.length - 1];

    if (hasOffscreenAPI) {
        // Chrome path: use offscreen document
        if (!(await hasDocument())) {
            await browserAPI.offscreen.createDocument({
                url: OFFSCREEN_DOCUMENT_PATH,
                reasons: [browserAPI.offscreen.Reason.DOM_PARSER],
                justification: 'Parse DOM'
            });
        }
        const type = button.hasOwnProperty('code') ? 'upload-stolen-button' : 'remove-stolen-button';
        browserAPI.runtime.sendMessage({
            type: type,
            target: 'offscreen',
            button: button,
            contentful: contentful
        });
    } else {
        // Firefox path: call Contentful directly
        if (button.hasOwnProperty('code')) {
            ffUpload(button, contentful);
        } else {
            ffRemove(button, contentful);
        }
    }
}

const handleMessages = async (message) => {
    if (message.target !== 'background') return;
    switch (message.type) {
        case 'stolen-button-uploaded':
            const { upload } = await browserAPI.storage.local.get(UPLOAD);
            upload.pop();
            browserAPI.runtime.sendMessage({
                type: 'full-refresh',
                target: 'stolen-buttons',
            });
            browserAPI.storage.local.set({ 'upload': upload });
            break;
        case 'contentful-syncronized':
            browserAPI.storage.local.set({ buttons: JSON.parse(message.value) });
            closeOffscreenDocument();
            break;
        case 'update-maximum':
            browserAPI.storage.local.set({ maximum: parseInt(message.value) });
            break;
        case 'update-contentful':
            browserAPI.storage.local.set({ contentful: JSON.parse(message.value) });
            break;
        case 'update-ignore':
            browserAPI.storage.local.set({ ignore: message.value.split(' ') });
            break;
        case 'remove-all':
            browserAPI.storage.local.set({ buttons: [], upload: [] })
            break;
        case 'remove-buttons':
            handleRemoveButtons(JSON.parse(message.value));
            break;
        case 'color-scheme-changed':
            if (isDark !== message.isDark) {
                isDark = message.isDark;
                browserAction.setIcon({
                    "path": {
                        "16": `/images/icon-${isDark? "dark" : "light"}-16.png`,
                        "32": `/images/icon-${isDark? "dark" : "light"}-32.png`,
                        "48": `/images/icon-${isDark? "dark" : "light"}-48.png`,
                        "128": `/images/icon-${isDark? "dark" : "light"}-128.png`
                    }
                })
            }
            break;
        default:
            break;
    }
}

const handleRemoveButtons = async (selected) => {
    const { buttons, upload } = await browserAPI.storage.local.get([BUTTONS, UPLOAD]);
    selected.forEach(s => {
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            if (button.stolenAt === s.stolenAt) {
                if (button.name === s.name) {
                    button.hidden = true;
                    break;
                }
            }
        }
    });
    browserAPI.storage.local.set({ buttons: buttons });
    upload.unshift(...selected);
    browserAPI.storage.local.set({ upload: upload });
}

browserAPI.runtime.onMessage.addListener(handleMessages);

// ── Offscreen document management (Chrome only) ──────────────────────

const closeOffscreenDocument = async () => {
    if (!hasOffscreenAPI) return;
    if (!(await hasDocument())) return;
    await browserAPI.offscreen.closeDocument();
}

const hasDocument = async () => {
    if (!hasOffscreenAPI) return false;
    if (typeof clients !== 'undefined' && clients.matchAll) {
        const matchedClients = await clients.matchAll();
        for (const client of matchedClients) {
            if (client.url.endsWith(OFFSCREEN_DOCUMENT_PATH)) {
                return true;
            }
        }
    }
    return false;
}
