import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            // SillyTavern externals — redirect imports that go 3–4 levels above the extension
            { find: '../../../extensions.js', replacement: resolve(__dirname, 'tests/__mocks__/st-extensions.js') },
            { find: '../../../../script.js', replacement: resolve(__dirname, 'tests/__mocks__/st-script.js') },
            { find: '../../../st-context.js', replacement: resolve(__dirname, 'tests/__mocks__/st-context.js') },
            { find: '../../../../st-context.js', replacement: resolve(__dirname, 'tests/__mocks__/st-context.js') },
            { find: '../../../world-info.js', replacement: resolve(__dirname, 'tests/__mocks__/st-world-info.js') },
            { find: '../../../../world-info.js', replacement: resolve(__dirname, 'tests/__mocks__/st-world-info.js') },
            { find: '../../../tool-calling.js', replacement: resolve(__dirname, 'tests/__mocks__/st-tool-calling.js') },
            { find: '../../../utils.js', replacement: resolve(__dirname, 'tests/__mocks__/st-utils.js') },
            { find: '../../../popup.js', replacement: resolve(__dirname, 'tests/__mocks__/st-popup.js') },
            { find: '../../../group-chats.js', replacement: resolve(__dirname, 'tests/__mocks__/st-group-chats.js') },
            { find: '../../../../chats.js', replacement: resolve(__dirname, 'tests/__mocks__/st-chats.js') },
            { find: '../../../power-user.js', replacement: resolve(__dirname, 'tests/__mocks__/st-power-user.js') },
        ],
    },
    test: {
        include: ['tests/**/*.test.js'],
    },
});
