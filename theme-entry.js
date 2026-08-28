import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { getSettings } from './tree-store.js';
import { applyTheme, bindThemeSelect, getThemeSelectValue } from './theme.js?v=theme-5';
import {
    isValidThemePreset,
    loadInstalledThemePresets,
    populateThemePresetOptions,
} from './theme-presets.js';

const initialSettings = getSettings();
applyTheme(initialSettings.colorTheme, document.documentElement, initialSettings.colorThemePreset);

// Keep TunnelVision's initializing module on its canonical URL. Several internal
// modules import ./index.js, so loading index.js with a query string would create
// a second module instance and run initialization twice.
await import('./index.js');

const themeSelect = document.getElementById('tv_color_theme');
const installedThemeSelect = document.getElementById('themes');
const installedThemeNames = Array.from(installedThemeSelect?.options || [])
    .map(option => option.value || option.textContent)
    .filter(Boolean)
    .map(name => ({ name: String(name).trim() }));

if (
    isValidThemePreset(initialSettings.colorThemePreset)
    && !installedThemeNames.some(theme => theme.name === initialSettings.colorThemePreset.name)
) {
    installedThemeNames.push({ name: initialSettings.colorThemePreset.name });
}
const populatedThemeSelects = new WeakSet();
const syncThemeSelect = (select) => {
    if (!select) return;
    if (!populatedThemeSelects.has(select)) {
        populateThemePresetOptions(select, installedThemeNames);
        populatedThemeSelects.add(select);
    }
    select.value = getThemeSelectValue(getSettings());
};
syncThemeSelect(themeSelect);

document.addEventListener('focusin', (event) => {
    const focusedSelect = event.target;
    if (!focusedSelect || focusedSelect.id !== 'tv_color_theme') return;
    syncThemeSelect(focusedSelect);
}, true);

let installedThemesPromise;
const loadThemes = () => {
    installedThemesPromise ??= loadInstalledThemePresets(fetch, getRequestHeaders())
        .catch(error => {
            installedThemesPromise = null;
            throw error;
        });
    return installedThemesPromise;
};
const resolvePreset = async (name) => {
    const presets = await loadThemes();
    return presets.find(preset => preset.name === name) || null;
};

// Bind after the canonical initializer. A browser may still have an older
// canonical index cached with its own theme listener. Capture-phase handling
// keeps that stale listener from rewriting a newly selected preset.
bindThemeSelect(themeSelect, getSettings, saveSettingsDebounced, document.documentElement, document, {
    resolvePreset,
    onPresetError: () => globalThis.toastr?.error?.(
        'Could not load that SillyTavern theme.',
        'TunnelVision theme',
    ),
});

if (themeSelect && typeof MutationObserver === 'function') {
    const themeMarkerObserver = new MutationObserver(() => {
        themeSelect.value = getThemeSelectValue(getSettings());
    });
    themeMarkerObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-tv-theme'],
    });
}
