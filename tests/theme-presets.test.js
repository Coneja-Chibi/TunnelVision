import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    createThemePreset,
    loadInstalledThemePresets,
    populateThemePresetOptions,
} from '../theme-presets.js';

describe('createThemePreset', () => {
    it('keeps only the installed theme colors TunnelVision uses', () => {
        const preset = createThemePreset({
            name: 'Azure',
            main_text_color: 'rgba(171, 198, 223, 1)',
            italics_text_color: 'rgba(255, 255, 255, 1)',
            quote_text_color: 'rgba(111, 133, 253, 1)',
            blur_tint_color: 'rgba(23, 30, 33, 0.61)',
            custom_css: 'body { display: none; }',
            unrelated: 'ignored',
        });

        expect(preset).toEqual({
            name: 'Azure',
            body: 'rgba(171, 198, 223, 1)',
            primary: 'rgba(255, 255, 255, 1)',
            secondary: 'rgba(111, 133, 253, 1)',
            tint: 'rgba(23, 30, 33, 0.61)',
        });
        expect(preset).not.toHaveProperty('custom_css');
    });
});

describe('loadInstalledThemePresets', () => {
    it('loads authenticated SillyTavern themes and drops invalid palettes', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                themes: [
                    {
                        name: 'Azure',
                        main_text_color: 'rgba(171, 198, 223, 1)',
                        italics_text_color: 'rgba(255, 255, 255, 1)',
                        quote_text_color: 'rgba(111, 133, 253, 1)',
                        blur_tint_color: 'rgba(23, 30, 33, 0.61)',
                    },
                    {
                        name: 'Broken',
                        main_text_color: 'not a color; background: red',
                        italics_text_color: '#fff',
                        quote_text_color: '#fff',
                        blur_tint_color: '#000',
                    },
                ],
            }),
        }));
        const headers = { 'X-CSRF-Token': 'test' };

        const presets = await loadInstalledThemePresets(fetchImpl, headers);

        expect(fetchImpl).toHaveBeenCalledWith('/api/settings/get', {
            method: 'POST',
            headers,
            body: '{}',
            cache: 'no-cache',
        });
        expect(presets).toHaveLength(1);
        expect(presets[0].name).toBe('Azure');
    });
});

describe('populateThemePresetOptions', () => {
    it('adds installed theme names as safe preset options', () => {
        const dom = new JSDOM(`
            <select id="tv_color_theme">
                <option value="brand">TunnelVision Pink</option>
                <optgroup id="tv_installed_theme_options"></optgroup>
            </select>
        `);
        const select = dom.window.document.getElementById('tv_color_theme');

        populateThemePresetOptions(select, [
            { name: 'Azure' },
            { name: '<img src=x onerror=alert(1)>' },
        ]);

        const options = [...select.querySelectorAll('#tv_installed_theme_options option')];
        expect(options.map(option => option.textContent)).toEqual([
            '<img src=x onerror=alert(1)>',
            'Azure',
        ]);
        expect(options.map(option => option.value)).toEqual([
            'preset:%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
            'preset:Azure',
        ]);
        expect(select.querySelector('img')).toBeNull();
    });
});
