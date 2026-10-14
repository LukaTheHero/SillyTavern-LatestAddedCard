import {
    characters,
    default_avatar,
    event_types,
    eventSource,
    getThumbnailUrl,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    this_chid,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { printTagList } from '../../../tags.js';
import { timestampToMoment } from '../../../utils.js';

const EXT_KEY = 'latestAddedCard';
const LOCAL_STORAGE_KEY = 'st_latest_added_card_v1';
const SLOT_ID = 'st_latest_added_card_slot';
const MAX_RECENT_HISTORY = 20;

const defaultSettings = {
    enabled: true,
    collapsed: false,
    recentAvatars: [],
    addedTimestamps: {},
};

let knownAvatarsSet = new Set();
let hasInitializedBaseline = false;
let currentHistoryOffset = 0;
let lastImportedAvatar = null;
let lastImportedAt = 0;
let listObserver = null;
let isInternalDomUpdate = false;

function getSettings() {
    if (!extension_settings[EXT_KEY]) {
        extension_settings[EXT_KEY] = structuredClone(defaultSettings);
    }
    const s = extension_settings[EXT_KEY];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (typeof s.collapsed !== 'boolean') s.collapsed = false;
    if (!Array.isArray(s.recentAvatars)) s.recentAvatars = [];
    if (!s.addedTimestamps || typeof s.addedTimestamps !== 'object') s.addedTimestamps = {};

    // Merge with localStorage backup so state is never lost on quick reload
    try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.recentAvatars)) {
                for (let i = parsed.recentAvatars.length - 1; i >= 0; i--) {
                    const av = parsed.recentAvatars[i];
                    if (av && !s.recentAvatars.includes(av)) {
                        s.recentAvatars.push(av);
                    }
                }
            }
            if (parsed.addedTimestamps && typeof parsed.addedTimestamps === 'object') {
                s.addedTimestamps = { ...parsed.addedTimestamps, ...s.addedTimestamps };
            }
        }
    } catch (e) {
        console.warn('[LatestAddedCard] Failed to read localStorage backup:', e);
    }

    return s;
}

function persistSettings() {
    const s = getSettings();
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
            recentAvatars: s.recentAvatars.slice(0, MAX_RECENT_HISTORY),
            addedTimestamps: s.addedTimestamps,
        }));
    } catch (e) {
        // Ignore quota errors
    }
    saveSettingsDebounced();
}

/**
 * Records a newly imported or created character avatar at the front of the recent history.
 * @param {string} avatarFileName
 * @param {boolean} [markJustImported=true]
 */
function recordNewlyAddedAvatar(avatarFileName, markJustImported = true) {
    if (!avatarFileName || typeof avatarFileName !== 'string') return;
    const normalized = avatarFileName.endsWith('.png') ? avatarFileName : `${avatarFileName}.png`;
    const s = getSettings();

    s.recentAvatars = [
        normalized,
        ...s.recentAvatars.filter(a => a !== normalized),
    ].slice(0, MAX_RECENT_HISTORY);

    const now = Date.now();
    s.addedTimestamps[normalized] = now;
    knownAvatarsSet.add(normalized);
    currentHistoryOffset = 0;

    if (markJustImported) {
        lastImportedAvatar = normalized;
        lastImportedAt = now;
    }

    persistSettings();
}

/**
 * Synchronizes `knownAvatarsSet` with the current `characters` array.
 * If new characters appeared since the baseline snapshot, promotes them to `recentAvatars`.
 */
function syncCharacterDiffs() {
    if (!Array.isArray(characters) || characters.length === 0) return;

    if (!hasInitializedBaseline) {
        for (const c of characters) {
            if (c?.avatar) knownAvatarsSet.add(c.avatar);
        }
        hasInitializedBaseline = true;
        return;
    }

    const newlyDiscovered = [];
    const currentSet = new Set();
    for (const c of characters) {
        if (!c?.avatar) continue;
        currentSet.add(c.avatar);
        if (!knownAvatarsSet.has(c.avatar)) {
            newlyDiscovered.push(c);
        }
    }

    knownAvatarsSet = currentSet;

    if (newlyDiscovered.length > 0) {
        // Sort ascending so the newest of the batch is recorded last (ending up at index 0)
        newlyDiscovered.sort((a, b) => getCharacterTimestampMs(a) - getCharacterTimestampMs(b));
        for (const c of newlyDiscovered) {
            recordNewlyAddedAvatar(c.avatar, true);
        }
    }
}

/**
 * Computes the best creation/import timestamp (in ms) for a character.
 * @param {object} char
 * @returns {number}
 */
function getCharacterTimestampMs(char) {
    if (!char) return 0;
    const s = getSettings();
    if (char.avatar && s.addedTimestamps[char.avatar]) {
        return Number(s.addedTimestamps[char.avatar]);
    }

    let createMs = 0;
    if (char.create_date) {
        try {
            const m = timestampToMoment(char.create_date);
            if (m && m.isValid()) {
                createMs = m.valueOf();
            }
        } catch {
            const parsed = Date.parse(char.create_date);
            if (!isNaN(parsed)) createMs = parsed;
        }
    }

    const dateAddedMs = Number(char.date_added) || 0;
    return createMs || dateAddedMs || 0;
}

/**
 * Returns an ordered array of `{ chid, item, timestampMs }` with the latest added character first.
 */
function getOrderedLatestCharacters() {
    if (!Array.isArray(characters) || characters.length === 0) return [];

    syncCharacterDiffs();

    const s = getSettings();
    const avatarToEntry = new Map();

    characters.forEach((item, index) => {
        if (!item || !item.avatar) return;
        avatarToEntry.set(item.avatar, {
            chid: index,
            item,
            timestampMs: getCharacterTimestampMs(item),
        });
    });

    const ordered = [];
    const seen = new Set();

    // 1. Explicitly tracked recent imports/creations first
    for (const avatar of s.recentAvatars) {
        const entry = avatarToEntry.get(avatar);
        if (entry && !seen.has(avatar)) {
            ordered.push(entry);
            seen.add(avatar);
        }
    }

    // 2. Remaining characters sorted by their import/creation timestamp descending
    const remaining = [];
    for (const [avatar, entry] of avatarToEntry.entries()) {
        if (seen.has(avatar)) continue;
        // Deprioritize stock default_Assistant unless it's the only card
        const isDefaultAssistant = avatar === 'default_Assistant.png' && characters.length > 1;
        remaining.push({
            ...entry,
            sortScore: isDefaultAssistant ? -1 : (Number(entry.item.date_added) || entry.timestampMs || 0),
        });
    }

    remaining.sort((a, b) => b.sortScore - a.sortScore);
    for (const r of remaining) {
        ordered.push(r);
    }

    return ordered;
}

/**
 * Formats a relative time string for the header badge.
 * @param {number} timestampMs
 * @returns {string}
 */
function formatRelativeTime(timestampMs) {
    if (!timestampMs || timestampMs <= 0) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 30) return `${diffDays}d ago`;
    const date = new Date(timestampMs);
    return date.toLocaleDateString();
}

/**
 * Builds the DOM element for the Latest Added Card slot.
 */
function buildLatestSlotElement() {
    const s = getSettings();
    if (!s.enabled) return null;

    const ordered = getOrderedLatestCharacters();
    if (ordered.length === 0) return null;

    const maxOffset = Math.min(ordered.length - 1, MAX_RECENT_HISTORY - 1);
    if (currentHistoryOffset > maxOffset) currentHistoryOffset = 0;
    if (currentHistoryOffset < 0) currentHistoryOffset = 0;

    const target = ordered[currentHistoryOffset];
    if (!target || !target.item) return null;

    const { chid, item, timestampMs } = target;
    const isCurrentActive = String(this_chid) === String(chid);
    const isJustImported = lastImportedAvatar === item.avatar && (Date.now() - lastImportedAt < 8000);

    const slot = document.createElement('div');
    slot.id = SLOT_ID;
    if (s.collapsed) slot.classList.add('st_lac_collapsed');
    if (isCurrentActive) slot.classList.add('st_lac_active_char');
    if (isJustImported) slot.classList.add('st_lac_just_imported');

    // --- Header Bar ---
    const header = document.createElement('div');
    header.className = 'st_lac_header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'st_lac_header_left';
    headerLeft.title = 'Click to collapse/expand Latest Added Card slot';

    const badgeIcon = document.createElement('i');
    badgeIcon.className = 'fa-solid fa-wand-magic-sparkles st_lac_badge_icon';
    headerLeft.appendChild(badgeIcon);

    const headerTitle = document.createElement('span');
    headerTitle.className = 'st_lac_header_title';
    headerTitle.textContent = currentHistoryOffset === 0 ? 'Latest Added Card' : `Recently Added (#${currentHistoryOffset + 1})`;
    headerLeft.appendChild(headerTitle);

    if (s.collapsed) {
        const collapsedPreview = document.createElement('span');
        collapsedPreview.className = 'st_lac_collapsed_preview';
        collapsedPreview.textContent = `— ${item.name}`;
        headerLeft.appendChild(collapsedPreview);
    }

    const headerRight = document.createElement('div');
    headerRight.className = 'st_lac_header_right';

    const timeText = formatRelativeTime(Number(item.date_added) || timestampMs);
    if (timeText) {
        const timeBadge = document.createElement('span');
        timeBadge.className = 'st_lac_time_badge';
        timeBadge.textContent = timeText;
        headerRight.appendChild(timeBadge);
    }

    // History cycle buttons (< 1/N >) so if the user imports multiple cards at once they can also step through them
    if (ordered.length > 1) {
        const navControls = document.createElement('div');
        navControls.className = 'st_lac_nav_controls';
        navControls.title = 'Cycle through recently added cards';

        const prevBtn = document.createElement('i');
        prevBtn.className = `fa-solid fa-chevron-left st_lac_nav_btn ${currentHistoryOffset === 0 ? 'disabled' : ''}`;
        prevBtn.title = 'Newer added card';
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentHistoryOffset > 0) {
                currentHistoryOffset--;
                renderLatestAddedSlot();
            }
        });

        const indexLabel = document.createElement('span');
        indexLabel.className = 'st_lac_nav_index';
        indexLabel.textContent = `${currentHistoryOffset + 1}`;

        const nextBtn = document.createElement('i');
        nextBtn.className = `fa-solid fa-chevron-right st_lac_nav_btn ${currentHistoryOffset >= maxOffset ? 'disabled' : ''}`;
        nextBtn.title = 'Previous added card';
        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentHistoryOffset < maxOffset) {
                currentHistoryOffset++;
                renderLatestAddedSlot();
            }
        });

        navControls.appendChild(prevBtn);
        navControls.appendChild(indexLabel);
        navControls.appendChild(nextBtn);
        headerRight.appendChild(navControls);
    }

    const collapseBtn = document.createElement('i');
    collapseBtn.className = `fa-solid ${s.collapsed ? 'fa-chevron-down' : 'fa-chevron-up'} st_lac_collapse_btn`;
    collapseBtn.title = s.collapsed ? 'Expand slot' : 'Collapse slot';

    const toggleCollapse = (e) => {
        e.stopPropagation();
        s.collapsed = !s.collapsed;
        persistSettings();
        renderLatestAddedSlot();
    };
    headerLeft.addEventListener('click', toggleCollapse);
    collapseBtn.addEventListener('click', toggleCollapse);
    headerRight.appendChild(collapseBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    slot.appendChild(header);

    // --- Card Row (matches SillyTavern's #character_template anatomy) ---
    let avatarSrc = default_avatar;
    if (item.avatar && item.avatar !== 'none') {
        avatarSrc = getThumbnailUrl('avatar', item.avatar);
    }

    const templateClone = $('#character_template .character_select').clone();
    // Replace .character_select with .st_latest_added_card_item so BulkEditOverlay and STCM folder hiders never interfere
    templateClone.removeClass('character_select').addClass('st_latest_added_card_item');
    templateClone.attr({
        'data-chid': String(chid),
        'chid': String(chid),
        'id': `LatestAddedCharID${chid}`,
    });

    templateClone.find('img').attr('src', avatarSrc).attr('alt', item.name || '');
    templateClone.find('.avatar').attr('title', `[Latest Added] ${item.name}\nFile: ${item.avatar}`);
    templateClone.find('.ch_name').text(item.name || '').attr('title', `[Character] ${item.name}`);

    if (power_user.show_card_avatar_urls) {
        templateClone.find('.ch_avatar_url').text(item.avatar);
    }
    templateClone.find('.ch_fav_icon').css('display', 'none');
    templateClone.toggleClass('is_fav', Boolean(item.fav || item.fav == 'true'));
    templateClone.find('.ch_fav').val(item.fav);
    templateClone.find('.ch_assistant').remove();

    const description = item.data?.creator_notes || '';
    if (description) {
        templateClone.find('.ch_description').text(description);
    } else {
        templateClone.find('.ch_description').hide();
    }

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (item.data && item.data[auxFieldName]) || '';
    if (auxFieldValue) {
        templateClone.find('.character_version').text(auxFieldValue);
    } else {
        templateClone.find('.character_version').hide();
    }

    const tagsElement = templateClone.find('.tags');
    if (tagsElement.length) {
        printTagList(tagsElement, { forEntityOrKey: chid, tagOptions: { isCharacterList: true } });
    }

    templateClone.on('click', async function (e) {
        e.stopPropagation();
        const targetChid = Number($(this).attr('data-chid'));
        if (!isNaN(targetChid) && characters[targetChid]) {
            await selectCharacterById(targetChid);
            setActiveCharacter(targetChid);
            setActiveGroup(null);
            saveSettingsDebounced();
            renderLatestAddedSlot();
        }
    });

    slot.appendChild(templateClone[0]);
    return slot;
}

/**
 * Renders or updates `#st_latest_added_card_slot` at the very top of `#rm_print_characters_block`
 * right after the pagination arrows and above all folders/groups.
 */
function renderLatestAddedSlot() {
    const container = document.getElementById('rm_print_characters_block');
    if (!container) return;

    isInternalDomUpdate = true;
    try {
        const existing = document.getElementById(SLOT_ID);
        if (existing) {
            existing.remove();
        }

        const slot = buildLatestSlotElement();
        if (slot) {
            container.prepend(slot);
        }
    } finally {
        isInternalDomUpdate = false;
    }
}

/**
 * Ensures the slot remains the very first element inside `#rm_print_characters_block`.
 */
function ensureListObserver() {
    const container = document.getElementById('rm_print_characters_block');
    if (!container || listObserver) return;

    listObserver = new MutationObserver(() => {
        if (isInternalDomUpdate) return;
        const slot = document.getElementById(SLOT_ID);
        if (!slot) {
            renderLatestAddedSlot();
        } else if (container.firstElementChild !== slot) {
            isInternalDomUpdate = true;
            try {
                container.prepend(slot);
            } finally {
                isInternalDomUpdate = false;
            }
        }
    });

    listObserver.observe(container, { childList: true });
}

/**
 * Intercepts character import & creation API calls so we immediately capture the exact newly added card
 * and keep the character list at the top of Page 1.
 */
function installImportInterceptor() {
    if (window.__stLatestAddedCardFetchInstalled) return;
    window.__stLatestAddedCardFetchInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (response.ok && reqUrl) {
                if (reqUrl.includes('/api/characters/import')) {
                    const cloned = response.clone();
                    cloned.json().then((data) => {
                        if (data && data.file_name) {
                            recordNewlyAddedAvatar(`${data.file_name}.png`, true);
                            keepListAtTopAfterImport();
                        }
                    }).catch(() => {});
                } else if (reqUrl.includes('/api/characters/create')) {
                    const cloned = response.clone();
                    cloned.text().then((avatarName) => {
                        if (avatarName && avatarName.trim()) {
                            recordNewlyAddedAvatar(avatarName.trim(), true);
                            keepListAtTopAfterImport();
                        }
                    }).catch(() => {});
                }
            }
        } catch (e) {
            // Never disrupt normal fetch flow
        }
        return response;
    };
}

/**
 * When a card is imported under "Recent" sort, SillyTavern's built-in 250ms timeout tries to jump
 * pagination to the last page (or fails if the card has a folder tag). We ensure pagination stays
 * on Page 1 and scrolls to the top so the user sees their newly imported card in the top slot immediately.
 */
function keepListAtTopAfterImport() {
    for (const delayMs of [60, 280, 450]) {
        setTimeout(() => {
            const container = document.getElementById('rm_print_characters_block');
            if (!container) return;
            try {
                const paginationEl = $('#rm_print_characters_pagination');
                if (paginationEl.length && typeof paginationEl.pagination === 'function') {
                    const currentPage = paginationEl.pagination('getSelectedPageNum');
                    if (currentPage && currentPage !== 1) {
                        paginationEl.pagination('go', 1);
                    }
                }
            } catch {
                // Ignore if pagination instance isn't ready
            }
            renderLatestAddedSlot();
            container.scrollTop = 0;
        }, delayMs);
    }
}

jQuery(() => {
    installImportInterceptor();

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
        ensureListObserver();
        renderLatestAddedSlot();
    });

    eventSource.on(event_types.APP_READY, () => {
        ensureListObserver();
        renderLatestAddedSlot();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderLatestAddedSlot();
    });

    // Also render immediately if characters are already loaded
    if (Array.isArray(characters) && characters.length > 0) {
        ensureListObserver();
        renderLatestAddedSlot();
    }
});
