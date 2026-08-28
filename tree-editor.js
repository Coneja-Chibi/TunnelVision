/**
 * TunnelVision Tree Editor
 * Handles the tree editor popup, tree rendering in the sidebar, import/export,
 * and all related helpers extracted from ui-controller.js.
 */

import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import {
    getTree,
    saveTree,
    deleteTree,
    createTreeNode,
    addEntryToNode,
    removeNode,
    removeEntryFromTree,
    getAllEntryUids,
    isTrackerUid,
    isTrackerTitle,
    setTrackerUid,
    syncTrackerUidsForLorebook,
} from './tree-store.js';
import { generateSummariesForTree } from './tree-builder.js';
import { registerTools } from './tool-registry.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml, getEntryVersions, updateEntry } from './entry-manager.js';
import { formatShortDateTime } from './shared-utils.js';
import { computeEntryQuality, getQualityRating, getQualityColor, qualityTooltip, buildQualityContext } from './entry-scoring.js';

// ─── Callbacks ───────────────────────────────────────────────────
// These are registered by ui-controller.js so the tree-editor can call back
// into the main UI without creating a circular dependency.

let _loadLorebookUI = null;
let _populateLorebookDropdown = null;

/**
 * Register callbacks that the tree editor needs from the main UI controller.
 * Must be called once during initialisation (e.g. inside bindUIEvents).
 *
 * @param {{ loadLorebookUI: Function, populateLorebookDropdown: Function }} cbs
 */
export function registerTreeEditorCallbacks({ loadLorebookUI, populateLorebookDropdown }) {
    _loadLorebookUI = loadLorebookUI;
    _populateLorebookDropdown = populateLorebookDropdown;
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Build a uid → entry lookup map from lorebook data.
 * @param {Object} bookData
 * @returns {Object}
 */
export function buildEntryLookup(bookData) {
    const lookup = {};
    if (!bookData || !bookData.entries) return lookup;
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        lookup[entry.uid] = entry;
    }
    return lookup;
}

/**
 * Return entries in bookData that are not assigned to any node in the tree.
 * Disabled entries are excluded.
 */
export function getUnassignedEntries(bookData, tree) {
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

// ─── Version History (Tree Editor) ────────────────────────────────

export function buildVersionHistoryElement(versions) {
    const $panel = $('<div class="tv-version-history" style="display:none"></div>');
    const $header = $('<div class="tv-version-history-header"><i class="fa-solid fa-clock-rotate-left"></i> Version History</div>');
    $panel.append($header);

    for (const ver of [...versions].reverse()) {
        const $item = $('<div class="tv-version-history-item"></div>');
        const time = new Date(ver.timestamp);
        const timeStr = formatShortDateTime(time);

        const $meta = $('<div class="tv-version-history-meta"></div>');
        $meta.append($(`<span class="tv-version-history-source"></span>`).text(ver.source || 'unknown'));
        $meta.append($(`<span class="tv-version-history-time"></span>`).text(timeStr));
        $item.append($meta);

        if (ver.previousTitle) {
            const $titleRow = $('<div class="tv-version-history-title"></div>');
            $titleRow.append('<span class="tv-version-history-label">Title: </span>');
            $titleRow.append($('<span></span>').text(ver.previousTitle));
            $item.append($titleRow);
        }

        if (ver.previousContent) {
            const $contentWrap = $('<div class="tv-content-copy-wrap"></div>');
            const $copyBtn = $('<button class="tv-content-copy-btn" title="Copy to clipboard"><i class="fa-solid fa-copy"></i></button>');
            $copyBtn.on('click', function (e) {
                e.stopPropagation();
                const $btn = $(this);
                navigator.clipboard.writeText(ver.previousContent).then(() => {
                    $btn.html('<i class="fa-solid fa-check"></i>').addClass('tv-content-copy-btn--done');
                    setTimeout(() => {
                        $btn.html('<i class="fa-solid fa-copy"></i>').removeClass('tv-content-copy-btn--done');
                    }, 1500);
                }).catch(() => {
                    $btn.html('<i class="fa-solid fa-xmark"></i>');
                    setTimeout(() => $btn.html('<i class="fa-solid fa-copy"></i>'), 1500);
                });
            });
            $contentWrap.append($copyBtn);
            $contentWrap.append($('<div class="tv-version-history-content"></div>').text(ver.previousContent));
            $item.append($contentWrap);
        }

        $panel.append($item);
    }

    return $panel;
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

/**
 * Export the current lorebook's tree as a JSON file download.
 * @param {string} currentLorebook - Name of the currently selected lorebook.
 */
export function onExportTree(currentLorebook) {
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

/**
 * Handle file-input change for importing a tree JSON.
 * @param {Event} e - The file input change event.
 * @param {string} currentLorebook - Name of the currently selected lorebook.
 */
export function onImportTree(e, currentLorebook) {
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
            if (_loadLorebookUI) _loadLorebookUI(currentLorebook);
            registerTools();
        } catch (err) {
            toastr.error(`Import failed: ${err.message}`, 'TunnelVision');
        }
    };
    reader.readAsText(file);// Reset file input so same file can be re-imported
    $(e.target).val('');
}

// ─── Tree Status ─────────────────────────────────────────────────

/**
 * Update the tree status text in the sidebar.
 */
export function updateTreeStatus(bookName, tree) {
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

// ─── Tree Editor Rendering (sidebar) ────────────────────────────

/**
 * Render the tree overview in the sidebar.
 */
export async function renderTreeEditor(bookName, tree) {
    const $container = $('#tv_tree_editor_container');

    if (!tree || !tree.root || ((tree.root.children || []).length === 0 && (tree.root.entryUids || []).length === 0)) {
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
    const categories = [];
    if ((tree.root.entryUids || []).length > 0) {
        categories.push({
            label: 'Root',
            summary: 'Entries stored directly on the root node.',
            entryUids: tree.root.entryUids,
            children: [],
        });
    }
    categories.push(...(tree.root.children || []));
    const colors = ['var(--tv-color-primary)', 'var(--tv-color-secondary)', '#6c5ce7', '#00b894', '#fdcb6e'];
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

/**
 * Render the unassigned entries panel in the sidebar.
 */
export async function renderUnassignedEntries(bookName, tree, bookData = null) {
    const $container = $('#tv_unassigned_container');
    const $count = $('#tv_unassigned_count');
    const $list = $('#tv_unassigned_list');

    if (!tree || !tree.root) {
        $list.empty();
        $container.hide();
        return;
    }

    const resolvedBookData = bookData || await loadWorldInfo(bookName);
    if (!resolvedBookData || !resolvedBookData.entries) {
        $list.empty();
        $container.hide();
        return;
    }

    const unassigned = getUnassignedEntries(resolvedBookData, tree);
    $count.text(unassigned.length);
    $list.empty();

    for (const entry of unassigned) {
        const label = entry.comment || entry.key?.[0] || `#${entry.uid}`;
        const $chip = $('<button type="button" class="tv-unassigned-chip"></button>');
        $chip.append($('<span class="tv-unassigned-chip-label"></span>').text(label));
        $chip.append($(`<span class="tv-unassigned-chip-uid">#${entry.uid}</span>`));
        $chip.append($('<span class="tv-unassigned-chip-action"><i class="fa-solid fa-arrow-turn-down"></i> Root</span>'));
        $chip.on('click', async () => {
            addEntryToNode(tree.root, entry.uid);
            saveTree(bookName, tree);
            toastr.success(`Assigned "${label}" to Root.`, 'TunnelVision');
            if (_loadLorebookUI) await _loadLorebookUI(bookName);
            if (_populateLorebookDropdown) _populateLorebookDropdown();registerTools();
        });
        $list.append($chip);
    }

    if (unassigned.length === 0) {
        $container.hide();
    } else {
        $container.show();
    }
}

// ─── Tree Editor Popup ───────────────────────────────────────────

/**
 * Open the tree editor popup for the given lorebook.
 * This is the main 556-line closure that was previously onOpenTreeEditor.
 *
 * @param {string} currentLorebook - The lorebook to open the editor for.
 */
export async function openTreeEditor(currentLorebook) {
    if (!currentLorebook) return;
    const tree = getTree(currentLorebook);
    if (!tree || !tree.root) {
        toastr.warning('Build a tree first before opening the editor.', 'TunnelVision');
        return;
    }

    const bookData = await loadWorldInfo(currentLorebook);
    if (bookData?.entries) {
        await syncTrackerUidsForLorebook(currentLorebook, bookData.entries);
    }
    const entryLookup = buildEntryLookup(bookData);
    const bookName = currentLorebook;

    // Pre-compute entry quality context once for the editor session
    const qualityCtx = buildQualityContext(bookData);

    // State: which node is selected in the tree
    let selectedNode = tree.root;

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

    function isRootNode(node) {
        return !!node && node.id === tree.root.id;
    }

    function countActiveEntries(node) {
        return getAllEntryUids(node).filter(uid => !!entryLookup[uid] && !entryLookup[uid].disable).length;
    }

    function assignEntryToNode(uid, targetNode) {
        removeEntryFromTree(tree.root, uid);
        addEntryToNode(targetNode, uid);
        saveTree(bookName, tree);}

    function renderTreeNodes() {
        $treeScroll.empty();
        $treeScroll.append(buildTreeNode(tree.root, 0, { isRoot: true }));
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

    function buildTreeNode(node, depth, { isRoot = false } = {}) {
        const $wrapper = $('<div class="tv-tree-node"></div>');
        const hasChildren = (node.children || []).length > 0;
        const isActive = selectedNode?.id === node.id;
        const count = countActiveEntries(node);
        const label = isRoot ? 'Root' : (node.label || 'Unnamed');

        const $row = $(`<div class="tv-tree-row${isActive ? ' active' : ''}${isRoot ? ' tv-tree-row-root' : ''}"></div>`);
        const $toggle = $(`<span class="tv-tree-toggle">${hasChildren ? (node.collapsed ? '\u25B6' : '\u25BC') : ''}</span>`);
        const $dot = $('<span class="tv-tree-dot"></span>');
        const $label = $('<span class="tv-tree-label"></span>').text(label);
        const $count = $(`<span class="tv-tree-count">${count}</span>`);

        // Click toggle to expand/collapse
        $toggle.on('click', (e) => {
            e.stopPropagation();
            node.collapsed = !node.collapsed;
            saveTree(bookName, tree);renderTreeNodes();
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
            if (!raw ||!/^\d+$/.test(raw)) return;
            const uid = Number(raw);
            assignEntryToNode(uid, node);
            selectNode(node);
            renderUnassignedEntries(bookName, tree, bookData);
            registerTools();
        });

        $row.append($toggle, $dot, $label, $count);
        $wrapper.append($row);

        // Children (recursive — no depth limit)
        if (hasChildren && !node.collapsed) {
            const $children = $('<div class="tv-tree-children"></div>');
            for (const child of node.children) {
                $children.append(buildTreeNode(child, depth + 1));
            }
            $wrapper.append($children);
        }

        return $wrapper;
    }

    function buildBreadcrumb(node) {
        if (node.id === '__unassigned__') {
            const $bc = $('<div class="tv-main-breadcrumb"></div>');
            const $rootCrumb = $('<span class="tv-bc-crumb"></span>').text('Root');
            $rootCrumb.on('click', () => selectNode(tree.root));
            $bc.append($rootCrumb);
            $bc.append($('<span class="tv-bc-sep">\u25B8</span>'));
            $bc.append($('<span class="tv-bc-current"></span>').text('Unassigned'));
            return $bc;
        }

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
                $crumb.on('click', () => selectNode(n));
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
        const isRoot = isRootNode(node);

        // Header
        const $header = $('<div class="tv-main-header"></div>');
        $header.append(buildBreadcrumb(node));

        const $titleRow = $('<div class="tv-main-title-row"></div>');
        if (!isUnassigned && !isRoot) {
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
                node.collapsed = false;
                saveTree(bookName, tree);
                selectNode(node);
                registerTools();
            });
            const $delNode = $('<button class="tv-popup-btn tv-popup-btn-danger" title="Delete this node"><i class="fa-solid fa-trash-can"></i></button>');
            $delNode.on('click', () => {
                if (!confirm(`Delete "${node.label}" and unassign its entries?`)) return;
                removeNode(tree.root, node.id);
                saveTree(bookName, tree);
                selectedNode = tree.root;
                renderTreeNodes();
                renderMainPanel();
                renderUnassignedEntries(bookName, tree, bookData);
                registerTools();
            });
            $actions.append($addSub, $delNode);
            $titleRow.append($actions);
        } else {
            $titleRow.append($('<div class="tv-main-title-static"></div>').text(isUnassigned ? 'Unassigned Entries' : 'Root'));
            if (isRoot) {
                const $actions = $('<div class="tv-main-title-actions"></div>');
                const $addSub = $('<button class="tv-popup-btn" title="Add category under root"><i class="fa-solid fa-folder-plus"></i></button>');
                $addSub.on('click', () => {
                    tree.root.children = tree.root.children || [];
                    tree.root.children.push(createTreeNode('New Category'));
                    tree.root.collapsed = false;
                    saveTree(bookName, tree);
                    selectNode(tree.root);
                    registerTools();
                });
                $actions.append($addSub);
                $titleRow.append($actions);
            }
        }
        $header.append($titleRow);
        $mainPanel.append($header);

        // Scrollable body
        const $body = $('<div class="tv-main-body"></div>');

        // Node summary
        if (node.summary && !isUnassigned && !isRoot) {
            $body.append($(`<div class="tv-node-summary">
                <div class="tv-node-summary-label">Node Summary</div>
                <div class="tv-node-summary-text"></div>
            </div>`).find('.tv-node-summary-text').text(node.summary).end());
        }

        // Direct entries
        const entryUids = node.entryUids || [];
        if (entryUids.length > 0) {
            const sectionLabel = isRoot ? 'Root Entries' : 'Direct Entries';
            $body.append($(`<div class="tv-entry-section-title">${sectionLabel}<span class="tv-entry-section-count">(${entryUids.length})</span></div>`));
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
                const childCount = countActiveEntries(child);
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
                $card.on('click', () => {
                    child.collapsed = false;
                    saveTree(bookName, tree);
                    selectNode(child);
                });
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

        // Health dot — quality indicator
        if (entry && !entry.disable) {
            const q = computeEntryQuality(entry, qualityCtx.maxUid, qualityCtx.feedbackMap, qualityCtx.recentText);
            const rating = getQualityRating(q);
            const color = getQualityColor(rating);
            const $dot = $(`<span class="tv-entry-health" title="${escapeHtml(qualityTooltip(q))}"></span>`);
            $dot.css('background', color);
            $row.append($dot);
        }

        $row.append($(`<span class="tv-entry-uid">#${uid}</span>`));

        // Tracker toggle
        if (entry) {
            const tracked = isTrackerUid(bookName, uid);
            const $tracker = $(`<button class="tv-btn-icon tv-entry-tracker ${tracked ? 'is-on' : ''}" title="${tracked ? 'Tracked entry' : 'Track this entry'}"><i class="fa-solid ${tracked ? 'fa-location-crosshairs' : 'fa-location-dot'}"></i></button>`);
            $tracker.on('click', (e) => {
                e.stopPropagation();
                const nextTracked = !$tracker.hasClass('is-on');
                setTrackerUid(bookName, uid, nextTracked);
                $tracker.toggleClass('is-on', nextTracked);
                $tracker.attr('title', nextTracked ? 'Tracked entry' : 'Track this entry');
                $tracker.find('i').attr('class', `fa-solid ${nextTracked ? 'fa-location-crosshairs' : 'fa-location-dot'}`);
                registerTools();
            });
            $row.append($tracker);
        }

        // Enable/disable toggle
        if (entry) {
            const isDisabled = !!entry.disable;
            const $toggle = $(`<button class="tv-btn-icon tv-entry-toggle ${isDisabled ? 'is-off' : ''}" title="${isDisabled ? 'Enable entry' : 'Disable entry'}"><i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`);
            $toggle.on('click', async (e) => {
                e.stopPropagation();
                const wasTracked = isTrackerUid(bookName, uid);
                entry.disable = !entry.disable;
                await saveWorldInfo(bookName, bookData, true);
                if (entry.disable) {
                    setTrackerUid(bookName, uid, false);
                } else if (wasTracked || isTrackerTitle(entry.comment)) {
                    setTrackerUid(bookName, uid, true);
                }
                $toggle.toggleClass('is-off', !!entry.disable);
                $toggle.attr('title', entry.disable ? 'Enable entry' : 'Disable entry');
                $toggle.find('i').attr('class', `fa-solid ${entry.disable ? 'fa-eye-slash' : 'fa-eye'}`);
                $row.toggleClass('is-disabled', !!entry.disable);
                renderTreeNodes();
                renderMainPanel();
                await renderUnassignedEntries(bookName, tree, bookData);
                registerTools();
            });
            $row.append($toggle);
            if (isDisabled) $row.addClass('is-disabled');
        }

        if (!isUnassigned) {
            const $remove = $('<button class="tv-btn-icon tv-btn-danger-icon tv-entry-remove" title="Remove from node"><i class="fa-solid fa-xmark"></i></button>');
            $remove.on('click', async (e) => {
                e.stopPropagation();
                node.entryUids = (node.entryUids || []).filter(u => u !== uid);
                saveTree(bookName, tree);
                renderMainPanel();
                renderTreeNodes();
                await renderUnassignedEntries(bookName, tree, bookData);
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
                    $row.removeClass('expanded');return;
                }
                // Close any other expanded entries
                $row.closest('.tv-entry-list-rows').find('.tv-entry-expand').slideUp(150, function () { $(this).remove(); });
                $row.closest('.tv-entry-list-rows').find('.tv-entry-row').removeClass('expanded');

                $row.addClass('expanded');
                const $expand = $('<div class="tv-entry-expand" style="display:none"></div>');

                // Node summary context
                if (node.summary && !isUnassigned && !isRootNode(node)) {
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

                // Editable title/content
                const originalTitle = entry.comment || '';
                const originalContent = entry.content || '';

                $expand.append($('<div class="tv-expand-label">Title</div>'));
                const $titleInput = $('<input type="text" class="tv-main-title" />').val(originalTitle);
                $titleInput.on('click keydown', (e) => e.stopPropagation());
                $expand.append($titleInput);

                $expand.append($('<div class="tv-expand-label">Content</div>'));
                const $contentWrap = $('<div class="tv-content-copy-wrap"></div>');
                const $copyBtn = $('<button class="tv-content-copy-btn" title="Copy to clipboard"><i class="fa-solid fa-copy"></i></button>');
                $copyBtn.on('click', function (e) {
                    e.stopPropagation();
                    const currentText = String($contentInput.val() ?? '');
                    const $btn = $(this);
                    navigator.clipboard.writeText(currentText).then(() => {
                        $btn.html('<i class="fa-solid fa-check"></i>').addClass('tv-content-copy-btn--done');
                        setTimeout(() => {
                            $btn.html('<i class="fa-solid fa-copy"></i>').removeClass('tv-content-copy-btn--done');
                        }, 1500);
                    }).catch(() => {
                        $btn.html('<i class="fa-solid fa-xmark"></i>');
                        setTimeout(() => $btn.html('<i class="fa-solid fa-copy"></i>'), 1500);
                    });
                });
                $contentWrap.append($copyBtn);

                const $contentInput = $('<textarea class="tv-expand-content" rows="6"></textarea>').val(originalContent);
                $contentInput.css({ width: '100%', resize: 'vertical' });
                $contentInput.on('click keydown', (e) => e.stopPropagation());
                $contentWrap.append($contentInput);
                $expand.append($contentWrap);

                const $editActions = $('<div class="tv-main-title-actions" style="margin-top:8px;"></div>');
                const $saveBtn = $('<button class="tv-popup-btn"><i class="fa-solid fa-floppy-disk"></i> Save</button>');
                const $cancelBtn = $('<button class="tv-popup-btn"><i class="fa-solid fa-rotate-left"></i> Cancel</button>');
                $editActions.append($saveBtn, $cancelBtn);
                $expand.append($editActions);

                function resetForm() {
                    $titleInput.val(originalTitle);
                    $contentInput.val(originalContent);
                }

                $cancelBtn.on('click', (e) => {
                    e.stopPropagation();
                    resetForm();
                });

                $saveBtn.on('click', async (e) => {
                    e.stopPropagation();
                    const nextTitle = String($titleInput.val() ?? '').trim();
                    const nextContent = String($contentInput.val() ?? '').trim();

                    if (!nextTitle) {
                        toastr.warning('Title cannot be empty.', 'TunnelVision');
                        return;
                    }
                    if (!nextContent) {
                        toastr.warning('Content cannot be empty.', 'TunnelVision');
                        return;
                    }

                    try {
                        $saveBtn.prop('disabled', true).find('i').addClass('fa-spin');
                        await updateEntry(bookName, uid, {
                            title: nextTitle,
                            content: nextContent,
                            source: 'tree-editor-inline',
                        });

                        entry.comment = nextTitle;
                        entry.content = nextContent;

                        $row.find('.tv-entry-name').text(nextTitle || entry.key?.[0] || `#${uid}`);
                        renderTreeNodes();
                        renderMainPanel();
                        await renderUnassignedEntries(bookName, tree, bookData);
                        registerTools();
                        toastr.success('Entry updated.', 'TunnelVision');
                    } catch (err) {
                        toastr.error(`Failed to update entry: ${err.message}`, 'TunnelVision');
                    } finally {
                        $saveBtn.prop('disabled', false).find('i').removeClass('fa-spin');
                    }
                });

                // Version history button
                const versions = getEntryVersions(bookName, uid);
                if (versions.length > 0) {
                    const $histBtn = $(`<button class="tv-btn tv-btn-sm tv-btn-secondary tv-history-btn"><i class="fa-solid fa-clock-rotate-left"></i> History (${versions.length})</button>`);
                    $histBtn.on('click', function (e) {
                        e.stopPropagation();
                        const $existing = $expand.find('.tv-version-history');
                        if ($existing.length) {
                            $existing.slideUp(150, () => $existing.remove());
                            return;
                        }
                        const $histPanel = buildVersionHistoryElement(versions);
                        $expand.append($histPanel);
                        $histPanel.slideDown(150);
                    });
                    $expand.append($histBtn);
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
        tree.root.collapsed = false;
        saveTree(bookName, tree);
        renderTreeNodes();
        renderMainPanel();
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

    $popup.find('#tv_popup_export').on('click', () => onExportTree(currentLorebook));
    $popup.find('#tv_popup_import').on('click', () => $('#tv_import_file').trigger('click'));
    $popup.find('#tv_popup_delete').on('click', () => {
        if (!confirm(`Delete the entire tree for "${bookName}"?`)) return;
        deleteTree(bookName);
        toastr.info('Tree deleted.', 'TunnelVision');
        if (_loadLorebookUI) _loadLorebookUI(bookName);
        if (_populateLorebookDropdown) _populateLorebookDropdown();
        registerTools();
        $('.popup.active .popup-button-close, .popup:last-child [data-i18n="Close"]').trigger('click');
    });

    // Search filter
    $popup.find('#tv_popup_search').on('input', function () {
        const q = $(this).val().toLowerCase().trim();
        $treeScroll.find('.tv-tree-row').each(function () {
            if ($(this).hasClass('tv-tree-row-root')) {
                $(this).closest('.tv-tree-node').show();
                return;
            }
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
    if (_loadLorebookUI) _loadLorebookUI(bookName);
    if (_populateLorebookDropdown) _populateLorebookDropdown();
}