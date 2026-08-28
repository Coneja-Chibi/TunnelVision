import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    applyTheme,
    bindThemeSelect,
    migrateLegacyThemeColors,
    THEME_IDS,
} from '../theme.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const stylesheet = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const settingsTemplate = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const uiControllerSource = readFileSync(new URL('../ui-controller.js', import.meta.url), 'utf8');
const themeEntrySource = readFileSync(new URL('../theme-entry.js', import.meta.url), 'utf8');

function findProductionJavaScript(directory = projectRoot) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === '.git') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...findProductionJavaScript(path));
        else if (entry.name.endsWith('.js')) files.push(path);
    }
    return files;
}

describe('applyTheme', () => {
    it('falls back to the brand theme when a saved theme is unknown', () => {
        const root = { dataset: {} };

        const appliedTheme = applyTheme('removed-theme', root);

        expect(appliedTheme).toBe(THEME_IDS.BRAND);
        expect(root.dataset.tvTheme).toBe(THEME_IDS.BRAND);
    });

    it('normalizes the stored value when the settings UI refreshes', () => {
        expect(uiControllerSource).toContain('settings.colorTheme = appliedTheme;');
    });

    it('reapplies the stored preset when the settings UI refreshes', () => {
        expect(uiControllerSource).toContain(
            'applyTheme(settings.colorTheme, document.documentElement, settings.colorThemePreset);',
        );
        expect(uiControllerSource).toContain('const presetName = settings.colorThemePreset?.name;');
        expect(uiControllerSource).toContain("$('#tv_color_theme').val(themeSelection);");
    });

    it('keeps the controller compatible with an older cached theme module', () => {
        expect(uiControllerSource).toContain("import { applyTheme } from './theme.js';");
        expect(uiControllerSource).not.toMatch(/import\s*\{[^}]*getThemeSelectValue[^}]*\}\s*from '\.\/theme\.js'/s);
    });

    it('applies a stored SillyTavern preset through TunnelVision-only variables', () => {
        const values = new Map();
        const root = {
            dataset: {},
            style: {
                setProperty(name, value) { values.set(name, value); },
                removeProperty(name) { values.delete(name); },
            },
        };
        const preset = {
            name: 'Azure',
            body: 'rgba(171, 198, 223, 1)',
            primary: 'rgba(255, 255, 255, 1)',
            secondary: 'rgba(111, 133, 253, 1)',
            tint: 'rgba(23, 30, 33, 0.61)',
        };

        expect(applyTheme(THEME_IDS.SILLY_TAVERN, root, preset)).toBe(THEME_IDS.SILLY_TAVERN);
        expect(root.dataset.tvTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(values.get('--tv-color-primary')).toBe(preset.primary);
        expect(values.get('--tv-color-secondary')).toBe(preset.secondary);
        expect(values.get('--tv-color-on-filled')).toBe(preset.body);
        expect(values.get('--tv-color-filled-primary')).toContain(preset.tint);
    });

    it('preserves preset variables when a cached caller omits the new preset argument', () => {
        const values = new Map();
        const root = {
            dataset: {},
            style: {
                setProperty: (name, value) => values.set(name, value),
                removeProperty: name => values.delete(name),
            },
        };
        const preset = {
            name: 'Azure',
            body: '#eef6ff',
            primary: '#5da9ff',
            secondary: '#8f7cff',
            tint: '#102038',
        };

        applyTheme(THEME_IDS.SILLY_TAVERN, root, preset);
        applyTheme(THEME_IDS.SILLY_TAVERN, root);

        expect(values.get('--tv-color-primary')).toBe('#5da9ff');
    });

    it('clears preset variables when Follow active is selected explicitly', () => {
        const values = new Map();
        const root = {
            dataset: {},
            style: {
                setProperty: (name, value) => values.set(name, value),
                removeProperty: name => values.delete(name),
            },
        };
        const preset = {
            name: 'Azure',
            body: '#eef6ff',
            primary: '#5da9ff',
            secondary: '#8f7cff',
            tint: '#102038',
        };

        applyTheme(THEME_IDS.SILLY_TAVERN, root, preset);
        applyTheme(THEME_IDS.SILLY_TAVERN, root, null);

        expect(values.has('--tv-color-primary')).toBe(false);
    });
});

describe('migrateLegacyThemeColors', () => {
    it('replaces persisted brand colors with live theme tokens', () => {
        const items = [
            { color: '#E84393' },
            { color: '#f0946c' },
            { color: '#00b894' },
        ];

        expect(migrateLegacyThemeColors(items)).toBe(true);
        expect(items).toEqual([
            { color: 'var(--tv-color-primary)' },
            { color: 'var(--tv-color-secondary)' },
            { color: '#00b894' },
        ]);
    });
});

describe('theme settings template', () => {
    it('cache-busts the JavaScript and stylesheet with the same asset revision', () => {
        const jsRevision = new URLSearchParams(manifest.js.split('?')[1]).get('v');
        const cssRevision = new URLSearchParams(manifest.css.split('?')[1]).get('v');

        expect(manifest.js.split('?')[0]).toBe('theme-entry.js');
        expect(manifest.css.split('?')[0]).toBe('style.css');
        expect(jsRevision).toMatch(/^theme-\d+$/);
        expect(cssRevision).toBe(jsRevision);
    });

    it('loads the initializing index module through one browser URL on reload', () => {
        const indexModuleUrls = [];
        if (manifest.js.split('?')[0] === 'index.js') indexModuleUrls.push(manifest.js);

        for (const path of findProductionJavaScript()) {
            const source = readFileSync(path, 'utf8');
            for (const match of source.matchAll(/['"](?:\.\.\/|\.\/)*index\.js(\?[^'"]*)?['"]/g)) {
                indexModuleUrls.push(`index.js${match[1] || ''}`);
            }
        }

        expect([...new Set(indexModuleUrls)]).toEqual(['index.js']);
    });

    it('offers both the original and SillyTavern color themes', () => {
        expect(settingsTemplate).toContain('id="tv_color_theme"');
        expect(settingsTemplate).toContain('option value="brand"');
        expect(settingsTemplate).toContain('option value="sillytavern"');
    });

    it('nests theme selection in an Appearance menu with installed presets', () => {
        expect(settingsTemplate).toContain('<details id="tv_appearance_menu"');
        expect(settingsTemplate).toContain('<span>Appearance</span>');
        expect(settingsTemplate).toContain(
            '<optgroup id="tv_installed_theme_options" label="Installed SillyTavern themes">',
        );
        expect(settingsTemplate).toContain('tv-appearance-chevron');
    });

    it('connects the theme selector to its help text', () => {
        expect(settingsTemplate).toContain('aria-describedby="tv_color_theme_help"');
        expect(settingsTemplate).toContain('id="tv_color_theme_help"');
    });

    it('applies the saved theme before initializing the settings panel', () => {
        const applyPosition = themeEntrySource.indexOf(
            'applyTheme(initialSettings.colorTheme, document.documentElement, initialSettings.colorThemePreset);',
        );
        const renderPosition = themeEntrySource.indexOf("await import('./index.js');");

        expect(applyPosition).toBeGreaterThan(-1);
        expect(applyPosition).toBeLessThan(renderPosition);
    });

    it('binds delegated theme changes after the canonical initializer loads', () => {
        const bindPosition = themeEntrySource.indexOf('bindThemeSelect(');
        const initPosition = themeEntrySource.indexOf("await import('./index.js');");

        expect(themeEntrySource).toContain("import { applyTheme, bindThemeSelect, getThemeSelectValue } from './theme.js?v=theme-5';");
        expect(themeEntrySource).toContain('bindThemeSelect(themeSelect, getSettings, saveSettingsDebounced');
        expect(bindPosition).toBeGreaterThan(initPosition);
    });

    it('connects installed preset options to SillyTavern theme loading', () => {
        expect(themeEntrySource).toContain('getRequestHeaders');
        expect(themeEntrySource).toContain('loadInstalledThemePresets');
        expect(themeEntrySource).toContain('populateThemePresetOptions');
        expect(themeEntrySource).toContain('colorThemePreset');
        expect(themeEntrySource).toContain('resolvePreset');
    });

    it('resyncs the preset option after an older cached controller refreshes the UI', () => {
        expect(themeEntrySource).toContain('new MutationObserver');
        expect(themeEntrySource).toContain("attributeFilter: ['data-tv-theme']");
        expect(themeEntrySource).toContain('themeSelect.value = getThemeSelectValue(getSettings());');
    });

    it('populates a replacement theme selector before it is used', () => {
        expect(themeEntrySource).toContain("document.addEventListener('focusin'");
        expect(themeEntrySource).toContain("focusedSelect.id !== 'tv_color_theme'");
        expect(themeEntrySource).toContain('syncThemeSelect(focusedSelect);');
    });
});

describe('theme stylesheet', () => {
    it('styles the nested Appearance menu without a duplicate browser marker', () => {
        expect(stylesheet).toContain('.tv-appearance-menu > summary');
        expect(stylesheet).toContain('list-style: none;');
        expect(stylesheet).toContain('.tv-appearance-menu[open] .tv-appearance-chevron');
    });

    it('maps the SillyTavern option to the host theme accent colors', () => {
        expect(stylesheet).toContain(':root[data-tv-theme="sillytavern"]');
        expect(stylesheet).toContain('--tv-color-primary: var(--SmartThemeEmColor');
        expect(stylesheet).toContain('--tv-color-secondary: var(--SmartThemeQuoteColor');
    });
    it('mixes filled accents with the host surface and uses the host foreground', () => {
        expect(stylesheet).toContain(
            '--tv-color-filled-primary: color-mix(in srgb, var(--SmartThemeEmColor, #e84393) 24%, var(--SmartThemeBlurTintColor, #222));',
        );
        expect(stylesheet).toContain(
            '--tv-color-on-filled: var(--SmartThemeBodyColor, #fff);',
        );
        expect(stylesheet).toContain(
            'background: linear-gradient(135deg, var(--tv-color-filled-primary) 0%, var(--tv-color-filled-secondary) 100%);',
        );
        expect(stylesheet).toContain('color: var(--tv-color-on-filled);');
    });
    it('uses theme tokens for every brand-colored component style', () => {
        const componentStyles = stylesheet.slice(stylesheet.indexOf('/* ===== Container'));

        expect(componentStyles).not.toMatch(/#(?:e84393|f0946c|ec6aaa|f4ad87|ec7fa0)\b/i);
        expect(componentStyles).not.toMatch(/rgba\((?:232,\s*67,\s*147|240,\s*148,\s*108),/i);
    });
    it('preserves the original floating tag text opacity with valid declarations', () => {
        expect(stylesheet).toContain(
            'color: color-mix(in srgb, var(--tv-color-primary) 70%, transparent);',
        );
        expect(stylesheet).toContain(
            'color: color-mix(in srgb, var(--tv-color-secondary) 80%, transparent);',
        );
    });
    it('uses theme tokens for brand colors set by JavaScript', () => {
        const hardcodedFiles = findProductionJavaScript().filter((path) => {
            const source = readFileSync(path, 'utf8');
            const themableSource = source.replace(
                /const LEGACY_BRAND_COLORS = Object\.freeze\(\{[\s\S]*?\}\);/,
                '',
            );
            return /#(?:e84393|f0946c|ec6aaa|f4ad87|ec7fa0)\b/i.test(themableSource);
        });

        expect(hardcodedFiles).toEqual([]);
    });
});

describe('bindThemeSelect', () => {
    it('lets the resolver-enabled wrapper own preset changes after canonical binding', async () => {
        const dom = new JSDOM(`
            <select id="tv_color_theme">
                <option value="brand">Brand</option>
                <option value="preset:Azure">Azure</option>
            </select>
        `);
        const { document } = dom.window;
        const select = document.getElementById('tv_color_theme');
        const settings = { colorTheme: THEME_IDS.BRAND, colorThemePreset: null };
        const preset = {
            name: 'Azure',
            body: '#eeeeee',
            primary: '#55aaff',
            secondary: '#8877ff',
            tint: '#18202a',
        };
        const canonicalSave = vi.fn();
        const wrapperSave = vi.fn();
        const resolvePreset = vi.fn(async () => preset);

        bindThemeSelect(select, () => settings, canonicalSave, document.documentElement, document);
        bindThemeSelect(select, () => settings, wrapperSave, document.documentElement, document, {
            resolvePreset,
        });
        select.value = 'preset:Azure';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(resolvePreset).toHaveBeenCalledTimes(1);
        expect(settings.colorThemePreset).toEqual(preset);
        expect(canonicalSave).not.toHaveBeenCalled();
        expect(wrapperSave).toHaveBeenCalledTimes(1);
    });

    it('normalizes an unknown saved theme without saving during initialization', () => {
        const select = { addEventListener: vi.fn() };
        const root = { dataset: {} };
        const settings = { colorTheme: 'removed-theme' };
        const saveSettings = vi.fn();

        bindThemeSelect(select, () => settings, saveSettings, root);

        expect(settings.colorTheme).toBe(THEME_IDS.BRAND);
        expect(select.value).toBe(THEME_IDS.BRAND);
        expect(root.dataset.tvTheme).toBe(THEME_IDS.BRAND);
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('ignores a missing settings control', () => {
        const root = { dataset: {} };
        const settings = { colorTheme: THEME_IDS.SILLY_TAVERN };
        const saveSettings = vi.fn();

        expect(() => bindThemeSelect(null, () => settings, saveSettings, root)).not.toThrow();
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('handles a selector that SillyTavern inserts or replaces after binding', () => {
        const listeners = {};
        const eventTarget = {
            addEventListener(type, listener) {
                listeners[type] = listener;
            },
        };
        const root = { dataset: {} };
        const settings = { colorTheme: THEME_IDS.BRAND };
        const saveSettings = vi.fn();

        bindThemeSelect(null, () => settings, saveSettings, root, eventTarget);
        const replacementSelect = { id: 'tv_color_theme', value: THEME_IDS.SILLY_TAVERN };
        listeners.change({ target: replacementSelect });

        expect(settings.colorTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(root.dataset.tvTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it('applies and saves a valid theme when the selection changes', () => {
        const listeners = {};
        const select = {
            value: '',
            addEventListener(type, listener) {
                listeners[type] = listener;
            },
        };
        const settings = { colorTheme: THEME_IDS.BRAND };
        const root = { dataset: {} };
        let saveCount = 0;

        bindThemeSelect(select, () => settings, () => saveCount++, root);
        select.value = THEME_IDS.SILLY_TAVERN;
        listeners.change();

        expect(settings.colorTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(root.dataset.tvTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(saveCount).toBe(1);
    });

    it('does not save twice when an older cached handler already applied the selection', () => {
        const listeners = {};
        const eventTarget = {
            addEventListener(type, listener) {
                listeners[type] = listener;
            },
        };
        const settings = { colorTheme: THEME_IDS.SILLY_TAVERN };
        const root = { dataset: { tvTheme: THEME_IDS.SILLY_TAVERN } };
        const saveSettings = vi.fn();

        bindThemeSelect(null, () => settings, saveSettings, root, eventTarget);
        listeners.change({
            target: { id: 'tv_color_theme', value: THEME_IDS.SILLY_TAVERN },
        });

        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('resolves and saves an installed theme without changing SillyTavern itself', async () => {
        const listeners = {};
        const eventTarget = {
            addEventListener(type, listener) {
                listeners[type] = listener;
            },
        };
        const values = new Map();
        const root = {
            dataset: {},
            style: {
                setProperty(name, value) { values.set(name, value); },
                removeProperty(name) { values.delete(name); },
            },
        };
        const settings = { colorTheme: THEME_IDS.BRAND, colorThemePreset: null };
        const preset = {
            name: 'Azure',
            body: 'rgba(171, 198, 223, 1)',
            primary: 'rgba(255, 255, 255, 1)',
            secondary: 'rgba(111, 133, 253, 1)',
            tint: 'rgba(23, 30, 33, 0.61)',
        };
        const saveSettings = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const changedSelect = { id: 'tv_color_theme', value: 'preset:Azure' };

        bindThemeSelect(null, () => settings, saveSettings, root, eventTarget, {
            resolvePreset: vi.fn(async name => name === 'Azure' ? preset : null),
        });
        await listeners.change({ target: changedSelect, stopImmediatePropagation });

        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(settings.colorTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(settings.colorThemePreset).toEqual(preset);
        expect(changedSelect.value).toBe('preset:Azure');
        expect(root.dataset.tvTheme).toBe(THEME_IDS.SILLY_TAVERN);
        expect(values.get('--tv-color-primary')).toBe(preset.primary);
        expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it('does not echo an untrusted missing preset name into an error', async () => {
        const listeners = {};
        const select = { id: 'tv_color_theme', value: 'brand' };
        const settings = { colorTheme: 'brand', colorThemePreset: null };
        const onPresetError = vi.fn();
        const eventTarget = {
            addEventListener: (type, listener) => { listeners[type] = listener; },
        };
        const changedSelect = {
            id: 'tv_color_theme',
            value: 'preset:%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
        };

        bindThemeSelect(select, () => settings, vi.fn(), { dataset: {} }, eventTarget, {
            resolvePreset: async () => null,
            onPresetError,
        });
        await listeners.change({ target: changedSelect, stopImmediatePropagation: vi.fn() });

        expect(onPresetError).toHaveBeenCalledTimes(1);
        expect(onPresetError.mock.calls[0][0].message).toBe('Installed theme is unavailable.');
    });

    it('ignores a pending preset when SillyTavern replaces the settings object', async () => {
        const listeners = {};
        const select = { id: 'tv_color_theme', value: 'brand' };
        const originalSettings = { colorTheme: 'brand', colorThemePreset: null };
        let currentSettings = originalSettings;
        const saveSettings = vi.fn();
        let finishPreset;
        const presetResult = new Promise(resolve => { finishPreset = resolve; });
        const eventTarget = {
            addEventListener: (type, listener) => { listeners[type] = listener; },
        };
        const values = new Map();
        const root = {
            dataset: {},
            style: {
                removeProperty: name => values.delete(name),
                setProperty: (name, value) => values.set(name, value),
            },
        };

        bindThemeSelect(select, () => currentSettings, saveSettings, root, eventTarget, {
            resolvePreset: () => presetResult,
        });
        select.value = 'preset:Azure';
        const pendingPresetChange = listeners.change({ target: select, stopImmediatePropagation: vi.fn() });

        currentSettings = { colorTheme: 'brand', colorThemePreset: null };
        applyTheme(currentSettings.colorTheme, root, currentSettings.colorThemePreset);
        select.value = 'brand';
        finishPreset({
            name: 'Azure',
            body: '#eef6ff',
            primary: '#5da9ff',
            secondary: '#8f7cff',
            tint: '#102038',
        });
        await pendingPresetChange;

        expect(currentSettings).toEqual({ colorTheme: 'brand', colorThemePreset: null });
        expect(originalSettings).toEqual({ colorTheme: 'brand', colorThemePreset: null });
        expect(root.dataset.tvTheme).toBe('brand');
        expect(values.has('--tv-color-primary')).toBe(false);
        expect(select.value).toBe('brand');
        expect(saveSettings).not.toHaveBeenCalled();
    });

    it('ignores a rejected preset from a replaced settings lifecycle', async () => {
        const listeners = {};
        const select = { id: 'tv_color_theme', value: 'brand' };
        let currentSettings = { colorTheme: 'brand', colorThemePreset: null };
        let rejectPreset;
        const presetResult = new Promise((_, reject) => { rejectPreset = reject; });
        const onPresetError = vi.fn();
        const eventTarget = {
            addEventListener: (type, listener) => { listeners[type] = listener; },
        };
        const root = {
            dataset: {},
            style: { removeProperty: vi.fn(), setProperty: vi.fn() },
        };

        bindThemeSelect(select, () => currentSettings, vi.fn(), root, eventTarget, {
            resolvePreset: () => presetResult,
            onPresetError,
        });
        select.value = 'preset:Azure';
        const pendingPresetChange = listeners.change({ target: select, stopImmediatePropagation: vi.fn() });

        currentSettings = { colorTheme: 'sillytavern', colorThemePreset: null };
        select.value = 'sillytavern';
        rejectPreset(new Error('obsolete request failed'));
        await pendingPresetChange;

        expect(select.value).toBe('sillytavern');
        expect(onPresetError).not.toHaveBeenCalled();
    });

    it('does not let a slow preset load overwrite a later selection', async () => {
        const listeners = {};
        const select = { id: 'tv_color_theme', value: 'brand' };
        const settings = { colorTheme: 'brand', colorThemePreset: null };
        const saveSettings = vi.fn();
        let finishPreset;
        const presetResult = new Promise(resolve => { finishPreset = resolve; });
        const eventTarget = {
            addEventListener: (type, listener) => { listeners[type] = listener; },
        };
        const root = {
            dataset: {},
            style: { removeProperty: vi.fn(), setProperty: vi.fn() },
        };

        bindThemeSelect(select, () => settings, saveSettings, root, eventTarget, {
            resolvePreset: () => presetResult,
        });
        const presetSelect = { id: 'tv_color_theme', value: 'preset:Azure' };
        const pendingPresetChange = listeners.change({ target: presetSelect, stopImmediatePropagation: vi.fn() });

        const brandSelect = { id: 'tv_color_theme', value: 'brand' };
        await listeners.change({ target: brandSelect, stopImmediatePropagation: vi.fn() });
        finishPreset({
            name: 'Azure',
            body: '#eef6ff',
            primary: '#5da9ff',
            secondary: '#8f7cff',
            tint: '#102038',
        });
        await pendingPresetChange;

        expect(settings.colorTheme).toBe('brand');
        expect(settings.colorThemePreset).toBeNull();
        expect(root.dataset.tvTheme).toBe('brand');
        expect(saveSettings).not.toHaveBeenCalled();
    });
});
