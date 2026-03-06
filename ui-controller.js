/**
 * TunnelVision UI Controller
 * Handles tree editor rendering, drag-and-drop, settings panel, and all user interactions.
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { selected_world_info, world_names, loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import { extension_settings } from '../../../extensions.js';
import { getAutoSummaryCount, resetAutoSummaryCount } from './auto-summary.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import {
    getTree,
    saveTree,
    deleteTree,
    isLorebookEnabled,
    setLorebookEnabled,
    createTreeNode,
    addEntryToNode,
    removeNode,
    removeEntryFromTree,
    getAllEntryUids,
    getSettings,
    getBookDescription,
    setBookDescription,
} from './tree-store.js';
import { buildTreeFromMetadata, buildTreeWithLLM, generateSummariesForTree, ingestChatMessages } from './tree-builder.js';
import { registerTools, unregisterTools } from './tool-registry.js';
import { runDiagnostics } from './diagnostics.js';
import { applyRecurseLimit } from './index.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';


let currentLorebook = null;

// ─── Event Bindings ──────────────────────────────────────────────

export function bindUIEvents() {
    // Main collapsible header
    $('#tv_header_toggle').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).closest('.tv-container').find('.tv-settings-body').slideToggle(200);
    });

    $('#tv_global_enabled').on('change', onGlobalToggle);
    $('#tv_lorebook_select').on('change', onLorebookSelect);
    $('#tv_lorebook_enabled').on('change', onLorebookToggle);
    $('#tv_book_description').on('input', onBookDescriptionChange);
    $('#tv_build_metadata').on('click', onBuildFromMetadata);
    $('#tv_build_llm').on('click', onBuildWithLLM);
    $('#tv_open_tree_editor').on('click', onOpenTreeEditor);
    $('#tv_import_file').on('change', onImportTree);

    $('#tv_run_diagnostics').on('click', onRunDiagnostics);

    // Lorebook filter
    $('#tv_lorebook_filter').on('input', onLorebookFilter);

    // Advanced Settings collapsible header
    $('#tv_advanced_header').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.tv-advanced-body').slideToggle(200);
    });

    // Per-tool toggles
    $(document).on('change', '.tv_tool_enabled', onToolToggle);

    // Search mode radio
    $('input[name="tv_search_mode"]').on('change', onSearchModeChange);

    // Recurse limit
    $('#tv_recurse_limit').on('change', onRecurseLimitChange);

    // LLM build detail level
    $('#tv_llm_detail').on('change', onLlmDetailChange);

    // LLM chunk size
    $('#tv_chunk_tokens').on('change', onChunkTokensChange);

    // Vector dedup toggle + threshold
    $('#tv_vector_dedup').on('change', onVectorDedupToggle);
    $('#tv_dedup_threshold').on('change', onDedupThresholdChange);

    // Chat ingest
    $('#tv_ingest_chat').on('click', onIngestChat);

    // Mandatory tool calls & stealth mode
    $('#tv_mandatory_tools').on('change', onMandatoryToolsToggle);
    $('#tv_stealth_mode').on('change', onStealthModeToggle);

    // !commands settings
    $('#tv_commands_enabled').on('change', onCommandsEnabledToggle);
    $('#tv_command_prefix').on('change', onCommandPrefixChange);
    $('#tv_command_context').on('change', onCommandContextChange);

    // Auto-summary settings
    $('#tv_auto_summary_enabled').on('change', onAutoSummaryToggle);
    $('#tv_auto_summary_interval').on('change', onAutoSummaryIntervalChange);
    $('#tv_auto_hide_summarized').on('change', onAutoHideSummarizedToggle);

    // Multi-book mode
    $('input[name="tv_multi_book_mode"]').on('change', onMultiBookModeChange);

    // Connection profile
    $('#tv_connection_profile').on('change', onConnectionProfileChange);

    // Diagnostics collapsible header
    $('#tv_diagnostics_header').on('click', function () {
        $(this).toggleClass('expanded');
        $(this).next('.tv-diagnostics-body').slideToggle(200);
    });

}

// ─── Refresh / Init ──────────────────────────────────────────────

export function refreshUI() {
    const settings = getSettings();
    const globalEnabled = settings.globalEnabled !== false;

    $('#tv_global_enabled').prop('checked', globalEnabled);
    $('#tv_main_controls').toggle(globalEnabled);

    // Sync tool toggles from settings
    const disabledTools = settings.disabledTools || {};
    $('.tv_tool_enabled').each(function () {
        const toolName = $(this).data('tool');
        $(this).prop('checked', !disabledTools[toolName]);
    });

    // Sync search mode radio
    $(`input[name="tv_search_mode"][value="${settings.searchMode || 'traversal'}"]`).prop('checked', true);

    // Sync recurse limit
    const recurseLimit = settings.recurseLimit ?? 5;
    $('#tv_recurse_limit').val(recurseLimit);
    $('#tv_recurse_warn').toggle(recurseLimit > 10);

    // Sync LLM detail level
    $('#tv_llm_detail').val(settings.llmBuildDetail || 'full');

    // Sync LLM chunk size
    $('#tv_chunk_tokens').val(settings.llmChunkTokens ?? 30000);

    // Sync vector dedup
    const dedupEnabled = settings.enableVectorDedup === true;
    $('#tv_vector_dedup').prop('checked', dedupEnabled);
    $('#tv_dedup_threshold_row').toggle(dedupEnabled);
    $('#tv_dedup_threshold').val(settings.vectorDedupThreshold ?? 0.85);
    updateDedupStatus(dedupEnabled);

    // Sync mandatory tool calls & stealth mode
    $('#tv_mandatory_tools').prop('checked', settings.mandatoryTools === true);
    $('#tv_stealth_mode').prop('checked', settings.stealthMode === true);

    // Sync !commands settings
    $('#tv_commands_enabled').prop('checked', settings.commandsEnabled !== false);
    $('#tv_command_prefix').val(settings.commandPrefix || '!');
    $('#tv_command_context').val(settings.commandContextMessages ?? 50);

    // Sync auto-summary settings
    const autoEnabled = settings.autoSummaryEnabled === true;
    $('#tv_auto_summary_enabled').prop('checked', autoEnabled);
    $('#tv_auto_summary_options').toggle(autoEnabled);
    $('#tv_auto_summary_interval').val(settings.autoSummaryInterval ?? 20);
    $('#tv_auto_summary_count').text(getAutoSummaryCount());
    $('#tv_auto_hide_summarized').prop('checked', settings.autoHideSummarized !== false);

    // Sync multi-book mode
    $(`input[name="tv_multi_book_mode"][value="${settings.multiBookMode || 'unified'}"]`).prop('checked', true);

    // Sync connection profile
    populateConnectionProfiles();

    populateLorebookDropdown();
    $('#tv_lorebook_controls').toggle(!!currentLorebook);

    if (currentLorebook) {
        loadLorebookUI(currentLorebook);
    }
}

function onLorebookFilter() {
    const query = $('#tv_lorebook_filter').val().toLowerCase().trim();
    $('#tv_lorebook_list .tv-lorebook-card').each(function () {
        const bookName = $(this).attr('data-book')?.toLowerCase() || '';
        $(this).toggle(!query || bookName.includes(query));
    });
}

function populateLorebookDropdown() {
    const $list = $('#tv_lorebook_list');
    $list.empty();

    if (!world_names?.length) {
        $list.append('<div class="tv-help-text" style="text-align:center; padding: 12px;">No lorebooks found.</div>');
        return;
    }

    // Sort: TV-enabled first, then active in chat, then alphabetical
    const activeBooks = getActiveTunnelVisionBooks();
    const sorted = [...world_names].sort((a, b) => {
        const aTV = isLorebookEnabled(a) ? 1 : 0;
        const bTV = isLorebookEnabled(b) ? 1 : 0;
        if (aTV !== bTV) return bTV - aTV;
        const aActive = activeBooks.includes(a) ? 1 : 0;
        const bActive = activeBooks.includes(b) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return a.localeCompare(b);
    });

    for (const name of sorted) {
        const isActive = activeBooks.includes(name);
        const tvEnabled = isLorebookEnabled(name);
        const tree = getTree(name);
        const hasTree = !!tree?.root?.children?.length;

        const $card = $('<div class="tv-lorebook-card"></div>')
            .toggleClass('tv-lorebook-active', isActive)
            .toggleClass('tv-lorebook-selected', name === currentLorebook)
            .attr('data-book', name);

        const $info = $('<div class="tv-lorebook-card-info"></div>');
        const $name = $('<span class="tv-lorebook-card-name"></span>').text(name);
        $info.append($name);

        // Status badges
        const $badges = $('<div class="tv-lorebook-card-badges"></div>');
        if (!isActive) {
            $badges.append('<span class="tv-badge-inactive">inactive</span>');
        }
        if (tvEnabled) {
            $badges.append('<span class="tv-badge-tv-on"><i class="fa-solid fa-eye"></i> TV On</span>');
        }
        if (hasTree) {
            const count = (tree.root.children || []).length;
            $badges.append(`<span class="tv-badge-tree">${count} cat</span>`);
        }
        $info.append($badges);

        // Status indicator dot
        const dotClass = tvEnabled ? 'tv-dot-on' : (hasTree ? 'tv-dot-ready' : 'tv-dot-off');
        const $dot = $(`<span class="tv-lorebook-dot ${dotClass}"></span>`);

        $card.append($dot, $info);

        $card.on('click', () => {
            currentLorebook = name;
            $('.tv-lorebook-card').removeClass('tv-lorebook-selected');
            $card.addClass('tv-lorebook-selected');
            $('#tv_lorebook_controls').show();
            loadLorebookUI(name);
        });

        $list.append($card);
    }
}

// ─── Lorebook & Toggle Handlers ──────────────────────────────────

function onGlobalToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.globalEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_main_controls').toggle(enabled);
    enabled ? registerTools() : unregisterTools();
}

function onLorebookSelect() {
    // Legacy handler for hidden select (kept for compatibility)
    const bookName = $(this).val();
    currentLorebook = bookName || null;
    $('#tv_lorebook_controls').toggle(!!bookName);
    if (bookName) loadLorebookUI(bookName);
}

async function loadLorebookUI(bookName) {
    $('#tv_lorebook_enabled').prop('checked', isLorebookEnabled(bookName));
    $('#tv_book_description').val(getBookDescription(bookName) || '');
    const tree = getTree(bookName);
    updateTreeStatus(bookName, tree);
    await renderTreeEditor(bookName, tree);
    await renderUnassignedEntries(bookName, tree);
    updateIngestUI();
}

function updateIngestUI() {
    const context = getContext();
    const hasChat = !!(context.chatId && context.chat?.length > 0);
    const hasBook = !!currentLorebook && isLorebookEnabled(currentLorebook);

    $('#tv_ingest_container').toggle(hasBook);

    if (hasChat) {
        const maxIdx = context.chat.length - 1;
        $('#tv_ingest_to').attr('max', maxIdx).val(maxIdx);
        $('#tv_ingest_from').attr('max', maxIdx);
        $('#tv_ingest_chat_info').text(`Chat has ${context.chat.length} messages (0-${maxIdx})`);
        $('#tv_ingest_chat').prop('disabled', false);
    } else {
        $('#tv_ingest_chat_info').text('No chat open. Open a chat to ingest messages.');
        $('#tv_ingest_chat').prop('disabled', true);
    }
}

function onLorebookToggle() {
    if (!currentLorebook) return;
    setLorebookEnabled(currentLorebook, $(this).prop('checked'));
    registerTools();
    populateLorebookDropdown(); // refresh badges
}

function onBookDescriptionChange() {
    if (!currentLorebook) return;
    const desc = $(this).val().trim();
    setBookDescription(currentLorebook, desc);
    saveSettingsDebounced();
}

function onToolToggle() {
    const toolName = $(this).data('tool');
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    const disabledTools = settings.disabledTools || {};
    if (enabled) {
        delete disabledTools[toolName];
    } else {
        disabledTools[toolName] = true;
    }
    settings.disabledTools = disabledTools;

    // Sync notebook injection setting with tool toggle
    if (toolName === 'TunnelVision_Notebook') {
        settings.notebookEnabled = enabled;
    }

    saveSettingsDebounced();
    registerTools();
}

function onSearchModeChange() {
    const mode = $('input[name="tv_search_mode"]:checked').val();
    const settings = getSettings();
    settings.searchMode = mode;
    saveSettingsDebounced();
    // Re-register to rebuild tool description with new mode
    registerTools();
}

function onRecurseLimitChange() {
    const raw = Number($('#tv_recurse_limit').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 5, 1), 50);
    $('#tv_recurse_limit').val(clamped);
    $('#tv_recurse_warn').toggle(clamped > 10);

    const settings = getSettings();
    settings.recurseLimit = clamped;
    saveSettingsDebounced();
    applyRecurseLimit(settings);
}

function onLlmDetailChange() {
    const settings = getSettings();
    settings.llmBuildDetail = $('#tv_llm_detail').val();
    saveSettingsDebounced();
}

function onChunkTokensChange() {
    const raw = Number($('#tv_chunk_tokens').val());
    const clamped = Math.min(Math.max(Math.round(raw / 1000) * 1000 || 30000, 5000), 500000);
    $('#tv_chunk_tokens').val(clamped);

    const settings = getSettings();
    settings.llmChunkTokens = clamped;
    saveSettingsDebounced();
}

function onVectorDedupToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.enableVectorDedup = enabled;
    saveSettingsDebounced();
    $('#tv_dedup_threshold_row').toggle(enabled);
    updateDedupStatus(enabled);
}

function onDedupThresholdChange() {
    const raw = Number($('#tv_dedup_threshold').val());
    const clamped = Math.min(Math.max(raw, 0.5), 0.99);
    $('#tv_dedup_threshold').val(clamped);

    const settings = getSettings();
    settings.vectorDedupThreshold = clamped;
    saveSettingsDebounced();
}

/**
 * Update the dedup status indicator.
 * @param {boolean} enabled
 */
function updateDedupStatus(enabled) {
    const $status = $('#tv_dedup_status');
    const $text = $('#tv_dedup_method_text');
    if (!enabled) {
        $status.hide();
        return;
    }
    $status.show();
    $text.text('Using trigram similarity — fast character n-gram matching that catches near-duplicates and morphological variants.');
}

// ─── Tree Building ───────────────────────────────────────────────

async function onBuildFromMetadata() {
    if (!currentLorebook) return;
    const $btn = $('#tv_build_metadata');
    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Building...');
        const tree = await buildTreeFromMetadata(currentLorebook);
        toastr.success(`Built tree with ${(tree.root.children || []).length} categories`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        populateLorebookDropdown();
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision]', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-sitemap"></i> From Metadata');
    }
}

async function onBuildWithLLM() {
    if (!currentLorebook) return;
    const $btn = $('#tv_build_llm');
    const $progress = $('#tv_build_progress');
    const $progressText = $('#tv_build_progress_text');
    const $progressFill = $('#tv_build_progress_fill');
    const $progressDetail = $('#tv_build_progress_detail');

    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Building...');
        $('#tv_build_metadata').prop('disabled', true);
        $progress.slideDown(200);
        $progressFill.css('width', '0%');
        $progressDetail.text('');

        const tree = await buildTreeWithLLM(currentLorebook, {
            onProgress: (msg, pct) => {
                $progressText.text(msg);
                if (typeof pct === 'number') {
                    $progressFill.css('width', `${Math.min(pct, 100)}%`);
                }
            },
            onDetail: (msg) => $progressDetail.text(msg),
        });

        $progressFill.css('width', '100%');
        $progressText.text('Done!');
        toastr.success(`LLM built tree with ${(tree.root.children || []).length} categories`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        populateLorebookDropdown();
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision]', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-brain"></i> With LLM');
        $('#tv_build_metadata').prop('disabled', false);
        setTimeout(() => $progress.slideUp(300), 2000);
    }
}

// ─── Chat Ingest ─────────────────────────────────────────────────

async function onIngestChat() {
    if (!currentLorebook) return;

    const context = getContext();
    if (!context.chatId || !context.chat?.length) {
        toastr.error('No chat is open. Open a chat first.', 'TunnelVision');
        return;
    }

    const from = parseInt($('#tv_ingest_from').val(), 10) || 0;
    const to = parseInt($('#tv_ingest_to').val(), 10) || 0;

    if (from > to) {
        toastr.warning('"From" must be less than or equal to "To".', 'TunnelVision');
        return;
    }

    const $btn = $('#tv_ingest_chat');
    const $progress = $('#tv_ingest_progress');
    const $progressText = $('#tv_ingest_progress_text');
    const $progressFill = $('#tv_ingest_progress_fill');
    const $progressDetail = $('#tv_ingest_progress_detail');

    try {
        $btn.prop('disabled', true).html('<span class="tv_loading"></span> Ingesting...');
        $progress.slideDown(200);
        $progressFill.css('width', '0%');
        $progressDetail.text('');

        const result = await ingestChatMessages(currentLorebook, {
            from,
            to,
            progress: (msg, pct) => {
                $progressText.text(msg);
                if (typeof pct === 'number') {
                    $progressFill.css('width', `${Math.min(pct, 100)}%`);
                }
            },
            detail: (msg) => $progressDetail.text(msg),
        });

        $progressFill.css('width', '100%');
        $progressText.text('Done!');
        toastr.success(`Created ${result.created} entries from chat (${result.errors} errors)`, 'TunnelVision');
        loadLorebookUI(currentLorebook);
        registerTools();
    } catch (e) {
        toastr.error(e.message, 'TunnelVision');
        console.error('[TunnelVision] Ingest error:', e);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i> Ingest Messages');
        setTimeout(() => $progress.slideUp(300), 2000);
    }
}

function onMandatoryToolsToggle() {
    const settings = getSettings();
    settings.mandatoryTools = $(this).prop('checked');
    saveSettingsDebounced();
}

function onStealthModeToggle() {
    const settings = getSettings();
    settings.stealthMode = $(this).prop('checked');
    saveSettingsDebounced();
    registerTools();
}

// ─── Commands Settings ───────────────────────────────────────────

function onCommandsEnabledToggle() {
    const settings = getSettings();
    settings.commandsEnabled = $(this).prop('checked');
    saveSettingsDebounced();
}

function onCommandPrefixChange() {
    const val = $(this).val()?.trim() || '!';
    $(this).val(val);
    const settings = getSettings();
    settings.commandPrefix = val;
    saveSettingsDebounced();
}

function onCommandContextChange() {
    const raw = Number($('#tv_command_context').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 50, 5), 500);
    $('#tv_command_context').val(clamped);
    const settings = getSettings();
    settings.commandContextMessages = clamped;
    saveSettingsDebounced();
}

// ─── Auto-Summary Settings ──────────────────────────────────────

function onAutoSummaryToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.autoSummaryEnabled = enabled;
    saveSettingsDebounced();
    $('#tv_auto_summary_options').toggle(enabled);
}

function onAutoSummaryIntervalChange() {
    const raw = Number($('#tv_auto_summary_interval').val());
    const clamped = Math.min(Math.max(Math.round(raw) || 20, 5), 200);
    $('#tv_auto_summary_interval').val(clamped);
    const settings = getSettings();
    settings.autoSummaryInterval = clamped;
    saveSettingsDebounced();
}

function onAutoHideSummarizedToggle() {
    const enabled = $(this).prop('checked');
    const settings = getSettings();
    settings.autoHideSummarized = enabled;
    saveSettingsDebounced();
}

// ─── Multi-Book Mode ─────────────────────────────────────────────

function onMultiBookModeChange() {
    const mode = $('input[name="tv_multi_book_mode"]:checked').val();
    const settings = getSettings();
    settings.multiBookMode = mode;
    saveSettingsDebounced();
    registerTools();
}

// ─── Connection Profile ──────────────────────────────────────────

function onConnectionProfileChange() {
    const settings = getSettings();
    settings.connectionProfile = $(this).val() || null;
    saveSettingsDebounced();
}

function populateConnectionProfiles() {
    const $select = $('#tv_connection_profile');
    const currentVal = getSettings().connectionProfile || '';

    // Keep the first option (default)
    $select.find('option:not(:first)').remove();

    // Read profiles from connection-manager extension settings
    try {
        const cmSettings = extension_settings?.connectionManager;
        if (cmSettings?.profiles && Array.isArray(cmSettings.profiles)) {
            for (const profile of cmSettings.profiles) {
                if (profile.name) {
                    $select.append($('<option></option>').val(profile.name).text(profile.name));
                }
            }
        }
    } catch {
        // Connection manager may not be loaded
    }

    $select.val(currentVal);
}

// ─── Tree Management ─────────────────────────────────────────────

async function onOpenTreeEditor() {
    if (!currentLorebook) return;
    const tree = getTree(currentLorebook);
    if (!tree || !tree.root) {
        toastr.warning('Build a tree first before opening the editor.', 'TunnelVision');
        return;
    }

    const bookData = await loadWorldInfo(currentLorebook);
    const entryLookup = buildEntryLookup(bookData);
    const bookName = currentLorebook;

    // State: which node is selected in the tree
    let selectedNode = tree.root.children?.[0] || tree.root;

    // Build the popup content
    const $popup = $('<div class="tv-popup-editor"></div>');

    // Toolbar
    const $toolbar = $(`<div class="tv-popup-toolbar">
        <div class="tv-popup-toolbar-left">
            <span class="tv-popup-title"><i class="fa-solid fa-folder-tree"></i> ${escapeHtml(bookName)}</span>
        </div>
        <div class="tv-popup-toolbar-right">
            <button class="tv-popup-btn" id="tv_popup_add_cat" title="Add category"><i class="fa-solid fa-folder-plus"></i> Add Category</button>
            <button class="tv-popup-btn" id="tv_popup_regen" title="Regenerate summaries"><i class="fa-solid fa-rotate"></i> Regen Summaries</button>
            <button class="tv-popup-btn" id="tv_popup_export" title="Export"><i class="fa-solid fa-file-export"></i></button>
            <button class="tv-popup-btn" id="tv_popup_import" title="Import"><i class="fa-solid fa-file-import"></i></button>
            <button class="tv-popup-btn tv-popup-btn-danger" id="tv_popup_delete" title="Delete tree"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    </div>`);
    $popup.append($toolbar);

    // Search bar
    const $search = $(`<div class="tv-popup-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="tv_popup_search" placeholder="Search categories and entries..." />
    </div>`);
    $popup.append($search);

    // Body: tree sidebar + main panel
    const $body = $('<div class="tv-popup-body"></div>');
    const $treeSidebar = $('<div class="tv-tree-sidebar"></div>');
    const $treeHeader = $('<div class="tv-tree-sidebar-header"><span>Tree</span></div>');
    const $treeScroll = $('<div class="tv-tree-sidebar-scroll"></div>');
    $treeSidebar.append($treeHeader, $treeScroll);

    const $mainPanel = $('<div class="tv-main-panel"></div>');

    $body.append($treeSidebar, $mainPanel);
    $popup.append($body);

    // --- Render functions ---

    function selectNode(node) {
        selectedNode = node;
        renderTreeNodes();
        renderMainPanel();
    }

    function renderTreeNodes() {
        $treeScroll.empty();
        for (const child of (tree.root.children || [])) {
            $treeScroll.append(buildTreeNode(child, 0));
        }
        // Unassigned pseudo-node
        const unassigned = getUnassignedEntries(bookData, tree);
        if (unassigned.length > 0) {
            const $unRow = $('<div class="tv-tree-row tv-tree-row-unassigned"></div>');
            $unRow.append($('<span class="tv-tree-toggle"></span>'));
            $unRow.append($('<span class="tv-tree-dot" style="opacity:0.4"></span>'));
            $unRow.append($('<span class="tv-tree-label" style="color:var(--SmartThemeQuoteColor,#888)"></span>').text('Unassigned'));
            $unRow.append($(`<span class="tv-tree-count">${unassigned.length}</span>`));
            $unRow.on('click', () => {
                selectedNode = { id: '__unassigned__', label: 'Unassigned', entryUids: unassigned.map(e => e.uid), children: [] };
                renderTreeNodes();
                renderMainPanel();
            });
            if (selectedNode?.id === '__unassigned__') $unRow.addClass('active');
            $treeScroll.append($('<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--SmartThemeBorderColor,#444)"></div>').append($unRow));
        }
    }

    function buildTreeNode(node, depth) {
        const $wrapper = $('<div class="tv-tree-node"></div>');
        const hasChildren = (node.children || []).length > 0;
        const isActive = selectedNode?.id === node.id;
        const count = getAllEntryUids(node).length;

        const $row = $(`<div class="tv-tree-row${isActive ? ' active' : ''}"></div>`);
        const $toggle = $(`<span class="tv-tree-toggle">${hasChildren ? (node._collapsed ? '\u25B6' : '\u25BC') : ''}</span>`);
        const $dot = $('<span class="tv-tree-dot"></span>');
        const $label = $('<span class="tv-tree-label"></span>').text(node.label || 'Unnamed');
        const $count = $(`<span class="tv-tree-count">${count}</span>`);

        // Click toggle to expand/collapse
        $toggle.on('click', (e) => {
            e.stopPropagation();
            node._collapsed = !node._collapsed;
            renderTreeNodes();
        });

        // Click row to select
        $row.on('click', () => selectNode(node));

        // Drop target: drag entries onto tree nodes
        $row.on('dragover', (e) => { e.preventDefault(); $row.addClass('tv-tree-drop-target'); });
        $row.on('dragleave', () => $row.removeClass('tv-tree-drop-target'));
        $row.on('drop', (e) => {
            e.preventDefault();
            $row.removeClass('tv-tree-drop-target');
            const raw = e.originalEvent.dataTransfer.getData('text/plain');
            if (!raw || !/^\d+$/.test(raw)) return;
            const uid = Number(raw);
            removeEntryFromTree(tree.root, uid);
            addEntryToNode(node, uid);
            saveTree(bookName, tree);
            selectNode(node);
            registerTools();
        });

        $row.append($toggle, $dot, $label, $count);
        $wrapper.append($row);

        // Children (recursive — no depth limit)
        if (hasChildren && !node._collapsed) {
            const $children = $('<div class="tv-tree-children"></div>');
            for (const child of node.children) {
                $children.append(buildTreeNode(child, depth + 1));
            }
            $wrapper.append($children);
        }

        return $wrapper;
    }

    function buildBreadcrumb(node) {
        const path = [];
        const findPath = (current, target, trail) => {
            trail.push(current);
            if (current.id === target.id) return true;
            for (const child of (current.children || [])) {
                if (findPath(child, target, trail)) return true;
            }
            trail.pop();
            return false;
        };
        findPath(tree.root, node, path);

        const $bc = $('<div class="tv-main-breadcrumb"></div>');
        for (let i = 0; i < path.length; i++) {
            if (i > 0) $bc.append($('<span class="tv-bc-sep">\u25B8</span>'));
            const n = path[i];
            const label = n === tree.root ? 'Root' : (n.label || 'Unnamed');
            if (i < path.length - 1) {
                const $crumb = $('<span class="tv-bc-crumb"></span>').text(label);
                $crumb.on('click', () => selectNode(n === tree.root ? (tree.root.children?.[0] || tree.root) : n));
                $bc.append($crumb);
            } else {
                $bc.append($('<span class="tv-bc-current"></span>').text(label));
            }
        }
        return $bc;
    }

    function renderMainPanel() {
        $mainPanel.empty();
        const node = selectedNode;
        if (!node) return;

        const isUnassigned = node.id === '__unassigned__';

        // Header
        const $header = $('<div class="tv-main-header"></div>');
        $header.append(buildBreadcrumb(node));

        const $titleRow = $('<div class="tv-main-title-row"></div>');
        if (!isUnassigned) {
            const $titleInput = $(`<input class="tv-main-title" type="text" />`).val(node.label || 'Unnamed');
            $titleInput.on('change', function () {
                node.label = $(this).val().trim() || 'Unnamed';
                saveTree(bookName, tree);
                renderTreeNodes();
                registerTools();
            });
            $titleRow.append($titleInput);

            const $actions = $('<div class="tv-main-title-actions"></div>');
            const $addSub = $('<button class="tv-popup-btn" title="Add sub-category"><i class="fa-solid fa-folder-plus"></i></button>');
            $addSub.on('click', () => {
                node.children = node.children || [];
                node.children.push(createTreeNode('New Sub-category'));
                saveTree(bookName, tree);
                node._collapsed = false;
                selectNode(node);
                registerTools();
            });
            const $delNode = $('<button class="tv-popup-btn tv-popup-btn-danger" title="Delete this node"><i class="fa-solid fa-trash-can"></i></button>');
            $delNode.on('click', () => {
                if (!confirm(`Delete "${node.label}" and unassign its entries?`)) return;
                removeNode(tree.root, node.id);
                saveTree(bookName, tree);
                selectedNode = tree.root.children?.[0] || tree.root;
                renderTreeNodes();
                renderMainPanel();
                registerTools();
            });
            $actions.append($addSub, $delNode);
            $titleRow.append($actions);
        } else {
            $titleRow.append($('<div class="tv-main-title-static">Unassigned Entries</div>'));
        }
        $header.append($titleRow);
        $mainPanel.append($header);

        // Scrollable body
        const $body = $('<div class="tv-main-body"></div>');

        // Node summary
        if (node.summary && !isUnassigned) {
            $body.append($(`<div class="tv-node-summary">
                <div class="tv-node-summary-label">Node Summary</div>
                <div class="tv-node-summary-text"></div>
            </div>`).find('.tv-node-summary-text').text(node.summary).end());
        }

        // Direct entries
        const entryUids = node.entryUids || [];
        if (entryUids.length > 0) {
            $body.append($(`<div class="tv-entry-section-title">Direct Entries <span class="tv-entry-section-count">(${entryUids.length})</span></div>`));
            const $list = $('<div class="tv-entry-list-rows"></div>');
            for (const uid of entryUids) {
                const entry = entryLookup[uid];
                $list.append(buildEntryRow(uid, entry, node, bookName, tree, isUnassigned));
            }
            $body.append($list);
        }

        // Child nodes
        const children = node.children || [];
        if (children.length > 0) {
            $body.append($(`<div class="tv-entry-section-title">Sub-categories <span class="tv-entry-section-count">(${children.length})</span></div>`));
            const $cards = $('<div class="tv-child-cards"></div>');
            for (const child of children) {
                const childCount = getAllEntryUids(child).length;
                const $card = $('<div class="tv-child-card"></div>');
                $card.append($('<span class="tv-tree-dot"></span>'));
                const $info = $('<div class="tv-child-card-info"></div>');
                $info.append($('<div class="tv-child-card-name"></div>').text(child.label || 'Unnamed'));
                if (child.summary) {
                    $info.append($('<div class="tv-child-card-summary"></div>').text(child.summary));
                }
                $card.append($info);
                $card.append($(`<span class="tv-child-card-count">${childCount}</span>`));
                $card.append($('<span class="tv-child-card-arrow">\u25B8</span>'));
                $card.on('click', () => { child._collapsed = false; selectNode(child); });
                $cards.append($card);
            }
            $body.append($cards);
        }

        $mainPanel.append($body);
    }

    function buildEntryRow(uid, entry, node, bookName, tree, isUnassigned) {
        const label = entry ? (entry.comment || entry.key?.[0] || `#${uid}`) : `#${uid} (deleted)`;

        const $row = $(`<div class="tv-entry-row" draggable="true" data-uid="${uid}"></div>`);
        $row.append($('<span class="tv-entry-drag">\u22EE\u22EE</span>'));
        $row.append($('<span class="tv-entry-name"></span>').text(label));
        $row.append($(`<span class="tv-entry-uid">#${uid}</span>`));

        // Enable/disable toggle
        if (entry) {
            const isDisabled = !!entry.disable;
            const $toggle = $(`<button class="tv-btn-icon tv-entry-toggle ${isDisabled ? 'is-off' : ''}" title="${isDisabled ? 'Enable entry' : 'Disable entry'}"><i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`);
            $toggle.on('click', async (e) => {
                e.stopPropagation();
                entry.disable = !entry.disable;
                await saveWorldInfo(bookName, bookData, true);
                $toggle.toggleClass('is-off', !!entry.disable);
                $toggle.attr('title', entry.disable ? 'Enable entry' : 'Disable entry');
                $toggle.find('i').attr('class', `fa-solid ${entry.disable ? 'fa-eye-slash' : 'fa-eye'}`);
                $row.toggleClass('is-disabled', !!entry.disable);
            });
            $row.append($toggle);
            if (isDisabled) $row.addClass('is-disabled');
        }

        if (!isUnassigned) {
            const $remove = $('<button class="tv-btn-icon tv-btn-danger-icon tv-entry-remove" title="Remove from node"><i class="fa-solid fa-xmark"></i></button>');
            $remove.on('click', (e) => {
                e.stopPropagation();
                node.entryUids = (node.entryUids || []).filter(u => u !== uid);
                saveTree(bookName, tree);
                renderMainPanel();
                renderTreeNodes();
                registerTools();
            });
            $row.append($remove);
        }

        // Drag
        $row.on('dragstart', (e) => {
            e.originalEvent.dataTransfer.setData('text/plain', String(uid));
            $row.addClass('dragging');
        });
        $row.on('dragend', () => $row.removeClass('dragging'));

        // Click to inline-expand entry detail
        if (entry) {
            $row.on('click', function () {
                const $existing = $row.next('.tv-entry-expand');
                if ($existing.length) {
                    $existing.slideUp(150, () => $existing.remove());
                    $row.removeClass('expanded');
                    return;
                }
                // Close any other expanded entries
                $row.closest('.tv-entry-list-rows').find('.tv-entry-expand').slideUp(150, function () { $(this).remove(); });
                $row.closest('.tv-entry-list-rows').find('.tv-entry-row').removeClass('expanded');

                $row.addClass('expanded');
                const $expand = $('<div class="tv-entry-expand" style="display:none"></div>');

                // Node summary context
                if (node.summary && !isUnassigned) {
                    $expand.append($(`<div class="tv-expand-node-box">
                        <div class="tv-expand-node-label">Parent node: ${escapeHtml(node.label || 'Unnamed')}</div>
                        <div class="tv-expand-node-text"></div>
                    </div>`).find('.tv-expand-node-text').text(node.summary).end());
                }

                // Keys
                const keys = entry.key || [];
                if (keys.length > 0) {
                    const $keys = $('<div class="tv-expand-keys"></div>');
                    $keys.append($('<span class="tv-expand-label">Keys</span>'));
                    const $tags = $('<div class="tv-expand-key-tags"></div>');
                    for (const k of keys) {
                        $tags.append($('<span class="tv-expand-key-tag"></span>').text(k));
                    }
                    $keys.append($tags);
                    $expand.append($keys);
                }

                // Content
                if (entry.content) {
                    $expand.append($('<div class="tv-expand-label">Content</div>'));
                    $expand.append($('<div class="tv-expand-content"></div>').text(entry.content));
                }

                $row.after($expand);
                $expand.slideDown(150);
            });
        }

        return $row;
    }

    // --- Initial render ---
    renderTreeNodes();
    renderMainPanel();

    // Wire toolbar buttons BEFORE showing popup (callGenericPopup awaits until close)
    $popup.find('#tv_popup_add_cat').on('click', () => {
        tree.root.children = tree.root.children || [];
        tree.root.children.push(createTreeNode('New Category'));
        saveTree(bookName, tree);
        renderTreeNodes();
        registerTools();
    });

    $popup.find('#tv_popup_regen').on('click', async () => {
        const $btn = $popup.find('#tv_popup_regen');
        try {
            $btn.prop('disabled', true).find('i').addClass('fa-spin');
            await generateSummariesForTree(tree.root, bookName);
            saveTree(bookName, tree);
            renderTreeNodes();
            renderMainPanel();
            registerTools();
            toastr.success('Summaries regenerated.', 'TunnelVision');
        } catch (e) {
            toastr.error(e.message, 'TunnelVision');
        } finally {
            $btn.prop('disabled', false).find('i').removeClass('fa-spin');
        }
    });

    $popup.find('#tv_popup_export').on('click', () => onExportTree());
    $popup.find('#tv_popup_import').on('click', () => $('#tv_import_file').trigger('click'));
    $popup.find('#tv_popup_delete').on('click', () => {
        if (!confirm(`Delete the entire tree for "${bookName}"?`)) return;
        deleteTree(bookName);
        toastr.info('Tree deleted.', 'TunnelVision');
        loadLorebookUI(bookName);
        populateLorebookDropdown();
        registerTools();
        $('.popup.active .popup-button-close, .popup:last-child [data-i18n="Close"]').trigger('click');
    });

    // Search filter
    $popup.find('#tv_popup_search').on('input', function () {
        const q = $(this).val().toLowerCase().trim();
        $treeScroll.find('.tv-tree-row').each(function () {
            const label = $(this).find('.tv-tree-label').text().toLowerCase();
            $(this).closest('.tv-tree-node').toggle(!q || label.includes(q));
        });
        $mainPanel.find('.tv-entry-row').each(function () {
            const name = $(this).find('.tv-entry-name').text().toLowerCase();
            $(this).toggle(!q || name.includes(q));
        });
    });

    // Show popup (blocks until user closes it)
    await callGenericPopup($popup, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    });

    // When popup closes, refresh sidebar UI
    loadLorebookUI(bookName);
    populateLorebookDropdown();
}

// ─── Tree Editor Helpers ─────────────────────────────────────────

function getUnassignedEntries(bookData, tree) {
    if (!bookData?.entries || !tree?.root) return [];
    const indexedUids = new Set(getAllEntryUids(tree.root));
    const unassigned = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        if (!indexedUids.has(entry.uid)) unassigned.push(entry);
    }
    return unassigned;
}

// ─── Import Sanitization ─────────────────────────────────────────

/**
 * Recursively sanitize an imported tree node.
 * Ensures all fields are the expected types, strips unexpected properties,
 * and prevents prototype pollution via __proto__ / constructor keys.
 * @param {Object} node
 */
function sanitizeImportedNode(node) {
    if (!node || typeof node !== 'object') return;

    // Enforce expected field types
    if (typeof node.id !== 'string' || !node.id) node.id = `tv_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof node.label !== 'string') node.label = 'Unnamed';
    if (typeof node.summary !== 'string') node.summary = '';
    if (!Array.isArray(node.entryUids)) node.entryUids = [];
    if (!Array.isArray(node.children)) node.children = [];

    // Sanitize entryUids — must be numbers
    node.entryUids = node.entryUids.filter(uid => typeof uid === 'number' && Number.isFinite(uid));

    // Strip any unexpected/dangerous keys (prototype pollution vectors)
    const allowed = new Set(['id', 'label', 'summary', 'entryUids', 'children', 'collapsed', 'isArc']);
    for (const key of Object.keys(node)) {
        if (!allowed.has(key)) delete node[key];
    }

    // Recurse children
    for (const child of node.children) {
        sanitizeImportedNode(child);
    }
}

// ─── Export / Import ─────────────────────────────────────────────

function onExportTree() {
    if (!currentLorebook) return;
    const tree = getTree(currentLorebook);
    if (!tree) {
        toastr.warning('No tree to export.', 'TunnelVision');
        return;
    }
    const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tunnelvision_${currentLorebook.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.info('Tree exported.', 'TunnelVision');
}

function onImportTree(e) {
    if (!currentLorebook) return;
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const tree = JSON.parse(ev.target.result);
            if (!tree.root || !Array.isArray(tree.root.children)) {
                throw new Error('Invalid tree structure.');
            }
            // Sanitize imported tree to prevent injection of unexpected properties
            sanitizeImportedNode(tree.root);
            tree.lorebookName = currentLorebook;
            tree.lastBuilt = Date.now();
            // Strip any unexpected top-level keys
            const cleanTree = {
                lorebookName: tree.lorebookName,
                root: tree.root,
                version: Number(tree.version) || 1,
                lastBuilt: tree.lastBuilt,
            };
            saveTree(currentLorebook, cleanTree);
            toastr.success('Tree imported.', 'TunnelVision');
            loadLorebookUI(currentLorebook);
            registerTools();
        } catch (err) {
            toastr.error(`Import failed: ${err.message}`, 'TunnelVision');
        }
    };
    reader.readAsText(file);
    // Reset file input so same file can be re-imported
    $(e.target).val('');
}

// ─── Tree Status ─────────────────────────────────────────────────

function updateTreeStatus(bookName, tree) {
    const $info = $('#tv_tree_info');
    if (!tree) {
        $info.text('No tree built yet.');
        return;
    }
    const totalEntries = getAllEntryUids(tree.root).length;
    const categories = (tree.root.children || []).length;
    const date = new Date(tree.lastBuilt).toLocaleString();
    $info.text(`${categories} categories, ${totalEntries} indexed entries. Last built: ${date}`);
}

// ─── Tree Editor Rendering ───────────────────────────────────────

async function renderTreeEditor(bookName, tree) {
    const $container = $('#tv_tree_editor_container');

    if (!tree || !tree.root || !(tree.root.children || []).length) {
        $container.hide();
        return;
    }

    $container.show();
    const totalEntries = getAllEntryUids(tree.root).length;
    const $count = $('#tv_tree_entry_count');
    if (totalEntries > 0) {
        $count.text(totalEntries).show();
    } else {
        $count.hide();
    }

    // Mini-kanban overview in sidebar
    const $overview = $('#tv_mini_kanban_overview');
    $overview.empty();
    const categories = tree.root.children || [];
    const colors = ['#e84393', '#f0946c', '#6c5ce7', '#00b894', '#fdcb6e'];
    for (let i = 0; i < categories.length; i++) {
        const cat = categories[i];
        const count = getAllEntryUids(cat).length;
        const color = colors[i % colors.length];
        const $row = $(`<div class="tv-mini-cat">
            <div class="tv-mini-cat-stripe" style="background:${color}"></div>
            <div class="tv-mini-cat-info">
                <div class="tv-mini-cat-name"></div>
                <div class="tv-mini-cat-summary"></div>
            </div>
            <div class="tv-mini-cat-count">${count}</div>
        </div>`);
        $row.find('.tv-mini-cat-name').text(cat.label || 'Unnamed');
        $row.find('.tv-mini-cat-summary').text(cat.summary || '');
        $overview.append($row);
    }
}

// ─── Unassigned Entries ──────────────────────────────────────────

async function renderUnassignedEntries(bookName, tree) {
    const $container = $('#tv_unassigned_container');
    const $count = $('#tv_unassigned_count');

    if (!tree || !tree.root) {
        $container.hide();
        return;
    }

    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        $container.hide();
        return;
    }

    const unassigned = getUnassignedEntries(bookData, tree);
    $count.text(unassigned.length);

    if (unassigned.length === 0) {
        $container.hide();
    } else {
        $container.show();
    }
}

// ─── Diagnostics ─────────────────────────────────────────────────

async function onRunDiagnostics() {
    const $btn = $('#tv_run_diagnostics');
    const $output = $('#tv_diagnostics_output');

    $btn.prop('disabled', true).html('<span class="tv_loading"></span> Running...');
    $output.empty().show();

    try {
        const results = await runDiagnostics();
        for (const result of results) {
            const icon = result.status === 'pass' ? 'fa-check' : result.status === 'warn' ? 'fa-triangle-exclamation' : 'fa-xmark';
            const cssClass = `tv_diag_${result.status}`;
            $output.append(`<div class="tv_diag_item ${cssClass}"><i class="fa-solid ${icon}"></i> ${escapeHtml(result.message)}</div>`);
        }
    } catch (e) {
        $output.append(`<div class="tv_diag_item tv_diag_fail"><i class="fa-solid fa-xmark"></i> Diagnostics error: ${escapeHtml(e.message)}</div>`);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-stethoscope"></i> Run Diagnostics');
    }
}

// ─── Utilities ───────────────────────────────────────────────────

function buildEntryLookup(bookData) {
    const lookup = {};
    if (!bookData || !bookData.entries) return lookup;
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        lookup[entry.uid] = entry;
    }
    return lookup;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
