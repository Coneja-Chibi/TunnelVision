const FALLBACK_COLOR_PATTERN = /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%+-]+\)|hsla?\([\d\s.,%+-]+\)|[a-z]+)$/i;
const PRESET_VALUE_PREFIX = 'preset:';

export function getThemePresetValue(name) {
    return `${PRESET_VALUE_PREFIX}${encodeURIComponent(String(name))}`;
}

export function getThemePresetName(value) {
    if (typeof value !== 'string' || !value.startsWith(PRESET_VALUE_PREFIX)) return null;
    try {
        const name = decodeURIComponent(value.slice(PRESET_VALUE_PREFIX.length)).trim();
        return name || null;
    } catch {
        return null;
    }
}

export function isSafeThemeColor(value, supportsColor = globalThis.CSS?.supports?.bind(globalThis.CSS)) {
    if (typeof value !== 'string') return false;
    const color = value.trim();
    if (!color || color.length > 128) return false;
    return supportsColor ? supportsColor('color', color) : FALLBACK_COLOR_PATTERN.test(color);
}

export function createThemePreset(theme, supportsColor) {
    if (!theme || typeof theme !== 'object') return null;
    const name = typeof theme.name === 'string' ? theme.name.trim() : '';
    if (!name || name.length > 128) return null;

    const preset = {
        name,
        body: theme.main_text_color,
        primary: theme.italics_text_color,
        secondary: theme.quote_text_color,
        tint: theme.blur_tint_color,
    };

    if (!Object.values(preset).slice(1).every(color => isSafeThemeColor(color, supportsColor))) {
        return null;
    }

    return preset;
}

export function isValidThemePreset(preset, supportsColor) {
    if (!preset || typeof preset !== 'object') return false;
    if (typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 128) return false;
    return ['body', 'primary', 'secondary', 'tint']
        .every(key => isSafeThemeColor(preset[key], supportsColor));
}

export async function loadInstalledThemePresets(
    fetchImpl = globalThis.fetch,
    headers = {},
    supportsColor,
) {
    if (typeof fetchImpl !== 'function') throw new Error('Theme loading is unavailable.');

    const response = await fetchImpl('/api/settings/get', {
        method: 'POST',
        headers,
        body: '{}',
        cache: 'no-cache',
    });
    if (!response?.ok) throw new Error(`Theme loading failed with HTTP ${response?.status ?? 'unknown'}.`);

    const data = await response.json();
    if (!Array.isArray(data?.themes)) return [];

    return data.themes
        .map(theme => createThemePreset(theme, supportsColor))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function populateThemePresetOptions(select, presets) {
    const group = select?.querySelector?.('#tv_installed_theme_options');
    const documentRef = select?.ownerDocument;
    if (!group || !documentRef?.createElement) return;

    group.replaceChildren();
    const sortedPresets = Array.isArray(presets)
        ? [...presets].filter(preset => preset?.name).sort((a, b) => a.name.localeCompare(b.name))
        : [];
    for (const preset of sortedPresets) {
        const option = documentRef.createElement('option');
        option.value = getThemePresetValue(preset.name);
        option.textContent = preset.name;
        group.appendChild(option);
    }
}
