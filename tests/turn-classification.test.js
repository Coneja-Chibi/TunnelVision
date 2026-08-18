import { describe, it, expect } from 'vitest';
import { isOocMessage, isOocTurn, isOocUserTurn, suppressTunnelVisionTools } from '../turn-classification.js';

describe('OOC turn classification', () => {
    it.each([
        'OOC explain the previous reply',
        '  OOC: change the formatting',
        'ooc please stop the scene',
    ])('recognizes an OOC prefix in %j', (text) => {
        expect(isOocMessage(text)).toBe(true);
    });

    it.each([
        'This mentions OOC later',
        'OOCly phrased',
        '',
        null,
    ])('does not match a non-prefix value %j', (text) => {
        expect(isOocMessage(text)).toBe(false);
    });

    it('uses the latest user message even after an assistant response', () => {
        const chat = [
            { is_user: true, mes: 'Normal roleplay' },
            { is_user: false, mes: 'Reply' },
            { is_user: true, mes: 'OOC adjust the style' },
            { is_user: false, mes: 'Understood' },
        ];

        expect(isOocUserTurn(chat)).toBe(true);
    });

    it('returns false when the latest user message is not OOC', () => {
        const chat = [
            { is_user: true, mes: 'OOC earlier instruction' },
            { is_user: false, mes: 'Understood' },
            { is_user: true, mes: 'Back in character' },
        ];

        expect(isOocUserTurn(chat)).toBe(false);
    });

    it('detects pending OOC textarea input before SillyTavern adds it to chat', () => {
        const chat = [
            { is_user: true, mes: 'Previous in-character message' },
            { is_user: false, mes: 'Previous reply' },
        ];

        expect(isOocTurn(chat, 'OOC do not use memory')).toBe(true);
    });

    it('falls back to chat history for swipe and regenerate flows', () => {
        const chat = [
            { is_user: true, mes: 'OOC revise your response' },
            { is_user: false, mes: 'Previous reply' },
        ];

        expect(isOocTurn(chat, '')).toBe(true);
    });
});

describe('OOC request tool suppression', () => {
    it('removes only TunnelVision tools and preserves other extensions', () => {
        const request = {
            tools: [
                { type: 'function', function: { name: 'TunnelVision_Search' } },
                { type: 'function', function: { name: 'Weather_Search' } },
                { name: 'TunnelVision_Guide' },
            ],
            tool_choice: { type: 'function', function: { name: 'TunnelVision_Search' } },
        };

        expect(suppressTunnelVisionTools(request)).toBe(2);
        expect(request.tools).toEqual([
            { type: 'function', function: { name: 'Weather_Search' } },
        ]);
        expect(request.tool_choice).toBe('auto');
    });

    it('disables a required choice when no tools remain', () => {
        const request = {
            tools: [{ type: 'function', function: { name: 'TunnelVision_Remember' } }],
            tool_choice: 'required',
        };

        expect(suppressTunnelVisionTools(request)).toBe(1);
        expect(request.tools).toBeUndefined();
        expect(request.tool_choice).toBe('none');
    });
});
