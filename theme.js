import {
    getThemePresetName,
    getThemePresetValue,
    isValidThemePreset,
} from './theme-presets.js';

export const THEME_IDS = Object.freeze({
    BRAND: 'brand',
    SILLY_TAVERN: 'sillytavern',
});

const VALID_THEMES = new Set(Object.values(THEME_IDS));

const PRESET_VARIABLES = Object.freeze([
    '--tv-color-primary',
    '--tv-color-secondary',
    '--tv-color-primary-hover',
    '--tv-color-secondary-hover',
    '--tv-color-primary-text',
    '--tv-color-filled-primary',
    '--tv-color-filled-secondary',
    '--tv-color-filled-primary-hover',
    '--tv-color-filled-secondary-hover',
    '--tv-color-on-filled',
]);

const LEGACY_BRAND_COLORS = Object.freeze({
    '#e84393': 'var(--tv-color-primary)',
    '#f0946c': 'var(--tv-color-secondary)',
});

export function normalizeTheme(theme) {
    return VALID_THEMES.has(theme) ? theme : THEME_IDS.BRAND;
}

export function getThemeSelectValue(settings) {
    const theme = normalizeTheme(settings?.colorTheme);
    return theme === THEME_IDS.SILLY_TAVERN && isValidThemePreset(settings?.colorThemePreset)
        ? getThemePresetValue(settings.colorThemePreset.name)
        : theme;
}

function clearPresetVariables(root) {
    if (!root?.style?.removeProperty) return;
    for (const variable of PRESET_VARIABLES) root.style.removeProperty(variable);
}

function applyPresetVariables(root, preset) {
    if (!root?.style?.setProperty || !isValidThemePreset(preset)) return false;
    const values = {
        '--tv-color-primary': preset.primary,
        '--tv-color-secondary': preset.secondary,
        '--tv-color-primary-hover': `color-mix(in srgb, ${preset.primary} 82%, white)`,
        '--tv-color-secondary-hover': `color-mix(in srgb, ${preset.secondary} 82%, white)`,
        '--tv-color-primary-text': preset.primary,
        '--tv-color-filled-primary': `color-mix(in srgb, ${preset.primary} 24%, ${preset.tint})`,
        '--tv-color-filled-secondary': `color-mix(in srgb, ${preset.secondary} 24%, ${preset.tint})`,
        '--tv-color-filled-primary-hover': `color-mix(in srgb, ${preset.primary} 32%, ${preset.tint})`,
        '--tv-color-filled-secondary-hover': `color-mix(in srgb, ${preset.secondary} 32%, ${preset.tint})`,
        '--tv-color-on-filled': preset.body,
    };
    for (const [variable, value] of Object.entries(values)) root.style.setProperty(variable, value);
    return true;
}

export function applyTheme(theme, root = document.documentElement, preset = undefined) {
    const normalizedTheme = normalizeTheme(theme);
    root.dataset.tvTheme = normalizedTheme;
    if (normalizedTheme === THEME_IDS.SILLY_TAVERN && preset === undefined) return normalizedTheme;
    clearPresetVariables(root);
    if (normalizedTheme === THEME_IDS.SILLY_TAVERN) applyPresetVariables(root, preset);
    return normalizedTheme;
}

export function migrateLegacyThemeColors(items) {
    if (!Array.isArray(items)) return false;

    let mutated = false;
    for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.color !== 'string') continue;
        const themedColor = LEGACY_BRAND_COLORS[item.color.toLowerCase()];
        if (!themedColor) continue;
        item.color = themedColor;
        mutated = true;
    }
    return mutated;
}

export function bindThemeSelect(
    select,
    getSettings,
    saveSettings,
    root = globalThis.document?.documentElement,
    eventTarget = globalThis.document,
    { resolvePreset, onPresetError } = {},
) {
    if (select) {
        const settings = getSettings();
        const initialTheme = applyTheme(settings.colorTheme, root, settings.colorThemePreset);
        settings.colorTheme = initialTheme;
        select.value = getThemeSelectValue(settings);
    }

    const hasPresetResolver = typeof resolvePreset === 'function';
    const changeTarget = hasPresetResolver
        ? (eventTarget?.addEventListener ? eventTarget : select)
        : (select?.addEventListener ? select : eventTarget);
    if (!changeTarget?.addEventListener) return;
    let selectionRevision = 0;

    changeTarget.addEventListener('change', async (event) => {
        const changedSelect = event?.target || select;
        if (!changedSelect || (changedSelect !== select && changedSelect.id !== 'tv_color_theme')) return;
        event?.stopImmediatePropagation?.();
        const revision = ++selectionRevision;

        const presetName = getThemePresetName(changedSelect.value);
        if (presetName) {
            const settings = getSettings();
            try {
                const preset = await resolvePreset?.(presetName);
                if (revision !== selectionRevision || settings !== getSettings()) return;
                if (!isValidThemePreset(preset) || preset.name !== presetName) {
                    throw new Error('Installed theme is unavailable.');
                }
                applyTheme(THEME_IDS.SILLY_TAVERN, root, preset);
                settings.colorTheme = THEME_IDS.SILLY_TAVERN;
                settings.colorThemePreset = preset;
                changedSelect.value = getThemePresetValue(preset.name);
                saveSettings();
            } catch (error) {
                if (revision !== selectionRevision || settings !== getSettings()) return;
                changedSelect.value = settings.colorTheme === THEME_IDS.SILLY_TAVERN
                    && isValidThemePreset(settings.colorThemePreset)
                    ? getThemePresetValue(settings.colorThemePreset.name)
                    : normalizeTheme(settings.colorTheme);
                onPresetError?.(error);
            }
            return;
        }

        const selectedTheme = normalizeTheme(changedSelect.value);
        changedSelect.value = selectedTheme;
        const settings = getSettings();
        if (
            settings.colorTheme === selectedTheme
            && !settings.colorThemePreset
            && root?.dataset?.tvTheme === selectedTheme
        ) return;

        applyTheme(selectedTheme, root, null);
        settings.colorTheme = selectedTheme;
        settings.colorThemePreset = null;
        saveSettings();
    }, hasPresetResolver);
}
