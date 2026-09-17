# 🔭📺 TunnelVision: Your AI Gets Its Own TV 📺🔭

*Stop making your AI guess what to remember. Give it a remote control and let it browse.* 🐰

[![Status: Active Development](https://img.shields.io/badge/Status-Active%20Development-blueviolet.svg)](https://github.com/Coneja-Chibi/TunnelVision)
[![SillyTavern Extension](https://img.shields.io/badge/SillyTavern-Extension-blue.svg)](https://docs.sillytavern.app/)
[![BunnyMo Compatible](https://img.shields.io/badge/BunnyMo-Compatible-pink.svg)](https://github.com/Coneja-Chibi/BunnyMo)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-green.svg)](LICENSE)

*A [RoleCall](https://github.com/Coneja-Chibi) project, built for the SillyTavern community as a proof of concept.* 🐇

---

### 💡 The Core Thesis

> **When an AI has to make the active effort to retrieve information, to decide what it needs, go find it, and bring it back, it uses that information better.**

Think about it. When RAG silently injects context into the prompt, the AI doesn't even know where it came from. It's just *there*. But when TunnelVision makes the AI *ask for* information, when it has to reason about what's relevant, navigate to it, and consciously retrieve it, the AI treats that information as something it *actively sought out*. It pays more attention. It integrates it more deliberately into its response. It's the difference between someone handing you a textbook page and you going to the library because you *needed* to know something.

That's the philosophy. Your AI should *think* about what it knows, not just have things shoved into its context window and hope for the best. 🧠

---

## 📺 What the Hell is TunnelVision?

You're paying for an intelligent AI. Claude, GPT-4, Gemini. These models can *reason*, *plan*, and *understand context*. So why the hell are you still using **dumb keyword matching** to decide what your AI gets to read? 💀

SillyTavern's default lorebook system works like a search bar. You type "Yuki" → the entry with "Yuki" as a keyword fires. Simple. Dumb. Brittle. What if the conversation is *about* Yuki but nobody said her name? What if the AI needs her backstory because Ren just mentioned "that girl from the academy," but "that girl from the academy" isn't a keyword? Too bad. Entry doesn't fire. Your AI writes Yuki completely wrong. 🤬

**TunnelVision flips the entire model.**

Instead of YOU setting up keywords and praying they trigger at the right time, TunnelVision gives your AI a **TV guide** (a structured channel listing of everything in your lorebook) and hands it the **remote control**. The AI *browses the channels*, *picks what's relevant*, and *tunes in* to exactly the information it needs for the current scene.

> *"Your AI doesn't Ctrl+F anymore. It picks up the remote and changes the channel."* 📺🐰

**The result?** Your lorebook entries activate when they're *contextually relevant*, not just when someone says the magic word. Characters get remembered when the conversation naturally involves them. World details surface when the plot actually needs them. The AI you're already paying for finally gets to use its intelligence for retrieval too.

---

## 🧠 Why This is Better (The Memory Problem)

Let's talk about **memory**. Every long-form RP, every persistent world, every character with a backstory. They all have the same problem: *the AI forgets things*. Context windows are limited. Old messages scroll off. Important details vanish.

Lorebooks were supposed to fix this. And they kinda do, if you're willing to maintain a massive keyword system, constantly update triggers, and hope that your 47-keyword entry fires at the right moment instead of the wrong one.

**TunnelVision solves memory differently.** Beyond storing information, it gives your AI the ability to **autonomously manage its own long-term memory**:

| The Old Way (Keywords) | The TunnelVision Way (AI-Driven) |
|------------------------|----------------------------------|
| YOU decide what triggers | THE AI decides what it needs |
| Keywords fire blindly when mentioned | Entries activate when contextually relevant |
| AI can't save new information | AI creates new memories mid-conversation 💾 |
| AI can't update outdated facts | AI edits entries when things change ✏️ |
| AI can't forget irrelevant stuff | AI disables entries that no longer matter 🗑️ |
| You manually organize everything | AI reorganizes the lorebook itself 🔀 |
| No event history | AI writes scene summaries automatically 📝 |

**Your lorebook isn't a static database anymore.** It's a living, breathing memory system that grows with your story. The AI remembers new things, corrects outdated things, forgets irrelevant things, and summarizes what happened. All autonomously. All via tool calls. No keyword juggling required.

---

## 🆚 "But What About RAG?"

Yeah, you've heard of RAG (Retrieval-Augmented Generation). SillyTavern has a built-in vector storage extension, and we even built **[VectHare](https://github.com/Coneja-Chibi/VectHare)**: a massively upgraded RAG system with temporal decay, importance weighting, multiple vector backends (Vectra, LanceDB, Qdrant), conditional activation rules, and scene management. VectHare is a *damn good* RAG implementation. We would know. We built it. 🐰

So why build TunnelVision too? Because **RAG and TunnelVision solve the same problem in fundamentally different ways**, and for lorebook retrieval specifically, TunnelVision's approach wins on three fronts:

### 1. 🧠 Contextual Reasoning vs Semantic Similarity

RAG uses **embeddings**. It converts your query and your lorebook entries into math vectors and finds the ones that are *numerically closest*. It's pattern matching with extra steps. It finds text that **looks similar** to what you asked for.

TunnelVision lets your AI **think about what it needs**. The model sees a structured overview of your entire knowledge base and *reasons* about which information is relevant to the current scene. Contextual understanding, applied to retrieval.

**Where base ST vectors fall short:** SillyTavern's built-in vector storage does basic semantic search. Ren says "I can't stop thinking about what happened at the bridge" and the vector store finds entries that contain similar words about bridges and thinking. It has no concept of *why* that information matters, who was involved, or what emotional weight the scene carries. It just matches surface-level text similarity.

**Where VectHare improves things (but still hits a ceiling):** VectHare adds temporal decay, importance weighting, conditional activation, and scene-aware chunking. It's genuinely excellent at what it does, and it *does* retrieve more intelligently than base vectors. But at the end of the day, even VectHare is still doing semantic similarity search with extra filters on top. The retrieval decision is still math, not reasoning.

**Where TunnelVision goes further:** The AI thinks: *"Ren is reflecting on a past event. I should check the Summaries channel for the bridge scene, AND pull up Ren's emotional state tracker, AND check Sable's entry since she was there too."* Three different categories, retrieved together, because the AI *understood the narrative context*. Semantic similarity will never beat contextual reasoning for this kind of retrieval. 🎯

### 2. ⚡ Zero Infrastructure, Zero Headache

RAG requires (even VectHare, good as it is):
- An **embedding model** (local or API, either way more setup and cost)
- A **vector database** (Vectra, LanceDB, Qdrant. VectHare supports all three, but you still pick and configure one)
- **Chunking strategy** decisions (how big? overlap? what gets embedded?)
- **Decay tuning**, similarity thresholds, conditional activation rules
- Periodic **re-indexing** when your lorebook changes

TunnelVision requires:
- A lorebook ✅
- An API that supports tool calls ✅
- Click "Build Tree" ✅
- That's it ✅

No extra models. No databases. No chunking math. No re-indexing. You're already paying for an intelligent model. TunnelVision just lets it do what it's good at. 🐰

### 3. 🔄 Read-Write vs Read-Only

This is the killer. **RAG is a search engine.** It retrieves. That's all it does. One direction. Information flows out of the lorebook into the context window, and nothing ever flows back.

TunnelVision is **bidirectional**. The AI reads *and writes*. It creates new entries, updates old ones, removes outdated information, writes summaries, reorganizes categories, and merges duplicates. Your knowledge base evolves autonomously as the story progresses.

RAG gives your AI a library card. TunnelVision makes your AI the librarian. 📚

### 🤝 They're Not Mutually Exclusive

Worth noting: **VectHare and TunnelVision can coexist.** VectHare excels at *chat history* retrieval, finding relevant past messages with temporal decay and conditional rules. TunnelVision excels at *lorebook* retrieval, letting the AI actively navigate and maintain your world knowledge. Use both if you want the best of both worlds.

---

## 📡 How the Broadcast Works

### 🗺️ **The Channel Guide** *(Your Tree Index)*

Every lorebook managed by TunnelVision gets organized into a **hierarchical tree**. Think of it as a TV guide with channels and sub-channels. TunnelVision builds this automatically (with or without LLM help) and generates summaries for each node so the AI knows what's on each channel without watching the whole thing.

```
📺 TunnelVision Guide
├── 📡 Ch. Characters
│   ├── 🗡️ Main Party
│   │   ├── Sable
│   │   │   ├── Personality & Backstory
│   │   │   ├── Relationships
│   │   │   └── Combat Style & Abilities
│   │   └── Ren
│   │       ├── Personality & Backstory
│   │       ├── Relationships
│   │       └── Combat Style & Abilities
│   ├── 👤 NPCs
│   │   ├── Thornfield NPCs
│   │   │   ├── The Merchant (shop inventory, personality)
│   │   │   └── The Guard Captain (patrol routes, disposition)
│   │   └── Underground NPCs
│   │       ├── The Fence (black market contacts, prices)
│   │       └── Pale Watcher (motives unknown, sightings)
│   └── 🐾 Creatures & Factions
│       ├── The Hollowed (behavior, weaknesses, territory)
│       └── Thornfield Militia (ranks, allegiances, resources)
├── 📡 Ch. Locations
│   ├── Thornfield
│   │   ├── Layout & Districts
│   │   ├── History & Politics
│   │   └── Secrets & Hidden Areas
│   └── The Underground
│       ├── Known Tunnels
│       ├── Dangers & Hazards
│       └── Faction Territory Map
├── 📡 Ch. Trackers
│   ├── [Tracker] Character Moods & States
│   └── [Tracker] Inventory & Equipment
├── 📡 Ch. World Rules
│   ├── Magic System (costs, limits, schools)
│   └── Calendar & Time (seasons, holidays, moon phases)
└── 📡 Ch. Summaries
    ├── Arc: The Curse Investigation
    │   ├── [Summary] The Ambush at Thornfield Bridge
    │   ├── [Summary] Sable Discovers the Ritual Site
    │   └── [Summary] Interrogating the Captured Scout
    ├── Arc: Underground Negotiations
    │   └── [Summary] First Contact with the Fence
    └── [Summary] First Meeting with the Merchant
```

Trees can go as deep as your lorebook needs. Two levels, five levels, ten levels. The AI navigates however many layers exist, drilling down until it reaches the entries it wants. Small lorebooks might only need a flat list of categories. Massive world-building lorebooks can have deeply nested hierarchies with dozens of sub-channels. TunnelVision handles both.

### 🔍 **Tuning In** *(Search Modes)*

Two ways the AI can browse, pick what works for your setup:

| Mode | How It Works | Best For |
|------|-------------|----------|
| 📡 **Traversal** (default) | AI sees top-level channels → picks one → tunes deeper → picks again → retrieves entries. Step by step, like channel surfing. | Large lorebooks, deep trees |
| 📋 **Collapsed** | Entire guide shown at once. AI picks channel IDs directly in one shot. Based on RAPTOR research. | Smaller lorebooks, faster retrieval |

### 🛠️ **8 AI Tools** *(The Full Remote Control)*

TunnelVision gives your AI a complete memory management toolkit. These register as **tool calls**, and the AI decides when and how to use them:

| Tool | What It Does | When AI Uses It |
|------|-------------|-----------------|
| 🔍 **Search** | Browse the channel guide and tune into relevant entries | Every turn (mandatory mode) or when context is needed |
| 💾 **Remember** | Create new lorebook entries mid-conversation | New facts, character developments, world details emerge |
| ✏️ **Update** | Edit existing entries when information changes | Character status changes, relationships evolve, facts get corrected |
| 🗑️ **Forget** | Disable/delete entries that are no longer relevant | Character dies, location destroyed, fact proven false |
| 📝 **Summarize** | Create scene/event summaries with significance levels | Important events happen: battles, confessions, discoveries |
| 🔀 **Reorganize** | Move entries between channels, create new channels | Tree structure no longer fits the growing lorebook |
| ✂️ **Merge/Split** | Combine related entries or split bloated ones | Two entries cover same topic, or one entry covers too many |
| 📓 **Notebook** | Private AI scratchpad for plans, follow-ups, narrative threads | AI needs to track something tactical across turns without permanent lorebook storage |

> **Your AI is the station manager.** It creates new programs, updates the schedule, cancels shows that jumped the shark, and writes episode recaps. Your lorebook evolves alongside your story. 📈

---

## 📺 The Broadcast Flow (Under the Hood)

```
You send a message
 ↓
📡 TunnelVision injects tool definitions into the API call
 ↓
🧠 AI thinks: "I need context about Sable for this scene"
 ↓
🔍 AI calls TunnelVision_Search (1st call)
 ↓
📺 AI sees the top-level channel guide:
   "Ch. Characters (12 entries) [has sub-channels]"
   "Ch. Locations (6 entries) [has sub-channels]"
   "Ch. Trackers (2 entries)"
   "Ch. World Rules (3 entries) [has sub-channels]"
   "Ch. Summaries (9 entries) [has sub-channels]"
 ↓
🔍 AI navigates into "Characters" (2nd call)
 ↓
📺 AI sees sub-channels:
   "Main Party [has sub-channels]"
   "NPCs [has sub-channels]"
   "Creatures & Factions"
 ↓
🔍 AI navigates into "Main Party" → "Sable" (3rd call)
 ↓
📺 AI sees Sable's sub-channels:
   "Personality & Backstory"
   "Relationships"
   "Combat Style & Abilities"
 ↓
🔍 AI retrieves "Personality & Backstory" + "Relationships" (4th call)
 ↓
📝 Sable's specific entries are returned to the AI
 ↓
💬 AI responds using Sable's accurate personality, backstory, relationships
 ↓
💾 AI notices something important happened → calls TunnelVision_Remember
 ↓
📚 New memory saved to lorebook, filed under the right channel
 ↓
✏️ AI also updates the mood tracker since Sable's emotional state changed
 ↓
🔄 Next turn: AI searches again, finds the new memories, story stays consistent
```

The depth of traversal depends on your tree structure and the recurse limit setting. Shallow trees resolve in 1-2 calls. Deep trees might take 3-5. The AI stops drilling when it finds what it needs.

**Meanwhile, normal keyword triggers are SUPPRESSED** for TV-managed lorebooks. No double-injection, no keyword conflicts. TunnelVision is the sole retrieval mechanism. The AI picks what it reads. 🎯

---

## 🔥 Features

### 🏷️ **Tracker Entries** *(Your AI's Notebook)*

This is one of TunnelVision's most powerful features. A **tracker** is a lorebook entry that contains whatever structured information you want the AI to maintain, and the AI will actively check and update it every turn.

**What can you track?** Literally anything:
- 👗 **Clothing & appearance**: what characters are wearing right now
- 💭 **Mood & emotional state**: how characters feel in this scene
- 🎒 **Inventory & equipment**: what characters are carrying
- 💕 **Relationship status**: how characters feel about each other
- 📍 **Position & location**: where everyone is physically
- 📊 **Stats & health**: HP, mana, conditions, whatever your system uses
- 📋 **Quest progress**: objectives, completed steps, current goals

**How it works:** You create a lorebook entry, flag it as "tracked," and TunnelVision injects its name into the Search and Update tool descriptions. This means the AI is *constantly reminded* that this tracker exists and should be checked/updated when relevant.

**Schema Collaboration:** You don't have to design your tracker format alone. TunnelVision has a built-in **Design Schema** command that lets you collaborate with the AI to build the perfect tracking format. Tell it what you want to track, and the AI will propose a structured schema. You refine it together, and the AI saves the result as your tracker entry. Example:

```
You: !remember design a mood and relationship tracker for Sable and Ren

AI creates a structured entry like:

[Tracker: Character States]
## Sable
- Mood: cautious, curious
- Trust toward Ren: 6/10 (growing)
- Current concern: the ritual site discovery
- Physical state: minor fatigue, left arm bruised

## Ren
- Mood: protective, conflicted
- Trust toward Sable: 8/10 (strong)
- Current concern: keeping the party safe
- Physical state: healthy, alert
```

Then you flag that entry as tracked. From that point on, the AI checks and updates it every turn. Moods shift as conversations happen, trust changes as characters interact, physical states update after combat. **The AI maintains it autonomously.** 📓

### 📊 **Activity Feed** *(What's Broadcasting Right Now)*

A floating widget that shows you exactly what TunnelVision is doing in real-time:
- Which tool calls fired this turn
- Which entries got retrieved
- What the AI remembered/updated/forgot
- Timestamps for everything

*No more wondering "did it even use my lorebook?" Now you can watch the broadcast live.* 👀

### ⚡ **User Commands** *(The Remote Control)*

Type commands directly in the chat box to force specific actions:

| Command | What It Does |
|---------|-------------|
| `!search [query]` | Force a lorebook search for the given query |
| `!remember [content]` | Force the AI to save something to memory |
| `!summarize [title]` | Force a scene summary with that title |
| `!forget [name]` | Force the AI to forget/disable an entry |
| `!merge [entries]` | Force a merge of related entries |
| `!split [entry]` | Force splitting a bloated entry |
| `!ingest` | Bulk-import recent chat messages into the lorebook (no generation) |

The prefix is configurable (default `!`). These strip from your message and inject a forced instruction. The AI has no choice but to comply. 😤

### 💬 **OOC Asides** *(Commercial Break)*

A message marked as out-of-character still gets full lorebook retrieval — it's a
question *about* the story — but it can't write. Write tools are stripped from the
request, the mandatory-tool instruction is withheld, and every post-turn writer
skips the turn.

**Recognised OOC markers:** `OOC: ...`, `(OOC: ...)`, `((OOC: ...))`,
`[OOC: ...]`, `<OOC> ...`, `**OOC** ...` — the literal word must be the first
token. A bare `[ ... ]` or `(( ... ))` is *not* treated as OOC, since those are
ordinary action beats and sound effects.

### 🔄 **Auto-Summary** *(The DVR)*

Configure an interval (e.g., every 20 messages) and TunnelVision will automatically tell the AI "you MUST summarize now." The AI creates a summary of recent events without you lifting a finger.

*Your story's DVR never runs out of space. Events from 50 messages ago are still on the record.* 📼

### 📚 **Multi-Lorebook Support** *(Multiple Channels, One Remote)*

Got multiple lorebooks active? TunnelVision handles them:

| Mode | Behavior |
|------|----------|
| 📡 **Unified** (default) | All lorebooks merged into one channel guide. AI sees everything as a single knowledge base. |
| 📖 **Per-Book** | AI sees each lorebook as a separate network and picks which one to browse. |

### 📖 **Narrative Arcs** *(Season Organization)*

Summaries can be grouped into **arcs**, named narrative threads under the Summaries channel. Think of them as seasons of your story.

The AI handles this **autonomously**. When it writes a summary, it can decide on its own that a new story thread has started and create a new arc for it. It can assign summaries to existing arcs when it recognizes they belong together. It can even use the Reorganize tool to move older summaries into an arc after the fact, if it realizes several loose summaries are actually part of the same plotline. You don't have to manage any of this. The AI organizes its own event history by narrative thread, automatically.

### 🧩 **Trigram Dedup** *(Rerun Detection)*

When the AI tries to Remember something, TunnelVision runs a fast trigram similarity check against existing entries. If something similar already exists, it warns the AI: *"Hey, this looks like a rerun. Maybe just update the existing entry instead."* Non-blocking (still saves), but dramatically reduces lorebook bloat.

### 🩺 **Built-In Diagnostics** *(Signal Check)*

One-click diagnostic panel that checks **everything**:
- Are your lorebooks actually active? ✅
- Do your trees have valid structures? ✅
- Are entry UIDs still valid (not stale)? ✅
- Is your API connected and supporting tool calls? ✅
- Are all tools properly registered? ✅
- Settings corrupted? Auto-fixed. ✅
- Orphaned trees from deleted lorebooks? Found. ✅
- 30+ checks with auto-fix for most issues

*When someone says "it's not working," run diagnostics first. It catches 90% of problems automatically.* 🔧

---

## 🚀 Installation & Setup

### Prerequisites

- **SillyTavern** (latest version recommended)
- **An API that supports tool calling** (Claude, GPT-4, Gemini, etc.)

### Step 1: Install 📥

Paste this URL into SillyTavern's "Install Extension" input:

```
https://github.com/Coneja-Chibi/TunnelVision
```

### Step 2: Set Up a Chat 📡

1. **🔧 Enable Master Toggle**: Switch on **Enable TunnelVision** in Extension Settings.
2. **🪄 Create Chat Lorebook**: Open a chat and click **Create Chat Lorebook**
   under *Lorebook Selection*. It suggests a name (`TV - <character>`, then
   `TV - <character> 2`, …), creates the lorebook, attaches it to this chat, turns
   TunnelVision on for it and selects it. Every memory TunnelVision saves in
   this chat goes here. The button is greyed out if the chat already has a chat
   lorebook, since SillyTavern allows only one.
   When it's done, a **"TV - &lt;character&gt; is ready"** toast confirms the
   setup and lists any Character Lore it switched on (step 3). In a chat that
   already has messages, the toast stays open with a **Next steps** list for
   step 4 until you close it.
3. **📖 Character Lore** *(only if the character has lorebooks linked via the
   globe button, e.g. an embedded lorebook you imported)*: the same popup
   offers to use them with TunnelVision as well. Leave them ticked — they're set to
   **Read Only**, so the AI can search the character's lore but never writes chat
   events into it.

   A **Build Tree Index** dropdown appears only if at least one of these lorebooks
   has never had a tree built. Your choice applies only to those lorebooks — a lorebook
   that already has a tree (say, from an earlier chat) is marked **(has a
   tree)**, keeps it, and is never rebuilt here. The dropdown is greyed out
   unless a ticked lorebook still needs a tree:
   - **With LLM**: sorts entries into categories with summaries (better retrieval, costs tokens)
   - **From Metadata**: groups entries by their existing groups and keys (instant, no LLM calls)
   - **Later**: select the lorebook in TunnelVision's lorebook list and use its **Build Tree Index** section yourself
   
   The tree is saved per lorebook, so later chats with the same character reuse it.
4. **📥 Existing chat?** With the new lorebook selected, click **Ingest Messages**
   under **Chat Ingest** to pull facts out of the chat so far. Then, under
   **Build Tree Index**, click **From Metadata** (free) or **With LLM** (better
   categories, costs tokens).
   A brand-new chat needs neither — its lorebook starts with an empty tree and fills
   up as you play.
5. **✅ Run Diagnostics**: Click "Run Diagnostics" to verify everything is green.

**Doing it by hand:** attach any lorebook to the chat with SillyTavern's
passport icon in the character panel (click it and pick the lorebook; once a lorebook
is attached, a plain click opens it and shift-click or long-press changes it),
click the lorebook in TunnelVision's lorebook list, switch on **Enable for this lorebook**,
and use **Build Tree Index**.
*Tip:* set **Advanced → Lorebooks & Tree Building → Auto-Detect Lorebooks** to
`TV - {{char}}` and any lorebook whose name contains `TV - <character>` is
switched on automatically — you only have to attach it.

### Step 3: Start Chatting 💬

That's it. TunnelVision registers its tools automatically. Your AI will start using Search, Remember, Summarize, etc. as the conversation flows.

**Optional power moves:**
- Turn on **Mandatory Tools** to force the AI to search every single turn
- Set up **Auto-Summary** to periodically create scene summaries
- Use **!commands** to manually trigger tools when you want specific actions
- Create **Tracker entries** for things the AI should constantly monitor and update
- Use `!remember` with a description to collaborate with the AI on designing tracker schemas

---

## ⚙️ Settings Reference

### Main Settings

| Setting | Default | What It Does |
|---------|---------|-------------|
| 🔧 Global Enable | ✅ On | Master kill switch for everything |
| 🔍 Search Mode | Traversal | How the AI browses the channel guide (traversal vs collapsed) |
| 🔄 Recurse Limit | 5 | Max recursive tool calls per generation (higher = deeper channel surfing) |
| 🧠 LLM Build Detail | Full | How much entry content the LLM sees during tree building |
| 📏 LLM Chunk Size | 30,000 | Characters per LLM chunk during tree building |
| ⚡ Mandatory Tools | ❌ Off | Force AI to use at least one tool call every turn |

### Advanced Settings

| Setting | Default | What It Does |
|---------|---------|-------------|
| 🔍 Dedup Detection | ❌ Off | Trigram similarity check on Remember (warns about reruns) |
| 📊 Dedup Threshold | 0.85 | How similar entries need to be to trigger a warning (0-1) |
| 💬 Commands Enabled | ✅ On | Allow !command syntax in chat |
| ❗ Command Prefix | `!` | Character that triggers command parsing |
| 🔄 Auto-Summary | ❌ Off | Inject summary instruction every N messages |
| 📊 Auto-Summary Interval | 20 | Messages between auto-summary triggers |
| 📚 Multi-Book Mode | Unified | How multiple lorebooks are presented (unified vs per-book) |
| 🔌 Connection Profile | (current) | Which API profile to use for tree building |

### Per-Tool Toggles

Every tool can be individually enabled/disabled in Advanced Settings:
Search, Remember, Update, Forget, Summarize, Reorganize, Merge/Split, Notebook

---

## 🔧 Common Issues

_**Run diagnostics first. Seriously. It catches 90% of problems automatically.**_ 🩺

### "The AI isn't using any tools!" 😤

1. Is TunnelVision **enabled**? (Master toggle in settings)
2. Is your **API connected** and does it **support tool calling**? (Not all models do)
3. Do you have at least one lorebook with TunnelVision **enabled** AND **active** in the current chat?
4. Did you **build a tree** for that lorebook?
5. Run **diagnostics**. It will tell you exactly what's wrong

### "Tools are registered but AI ignores them!" 😭

- Turn on **Mandatory Tools**. This forces the AI to use at least one tool per turn
- Some models are lazy about tool calls unless explicitly prompted. Mandatory mode fixes this.
- Check your **recurse limit**. If it's 1, the AI can only make one tool call per turn, which may not be enough for traversal mode

### "My lorebook entries are firing twice!" 💢

TunnelVision automatically **suppresses normal keyword scanning** for its managed lorebooks. If you're seeing double-injection:
- Make sure the lorebook has TunnelVision **enabled** (not just active in ST)
- Your ST version may be too old. The `WORLDINFO_ENTRIES_LOADED` event is required for suppression
- Run diagnostics. It checks for this specifically

### "Tree building is taking forever / costing too much!" 💸

- Use **Quick Build** (metadata-only) instead of LLM build. It's instant and free
- If using LLM build, lower the **LLM Build Detail** to "Lite" or "Names"
- Increase **Chunk Size** to send more entries per LLM call (fewer calls total)
- LLM build is a one-time cost. You don't need to rebuild unless your lorebook structure changes significantly

### "The AI keeps saving duplicate entries!" 🔁

- Enable **Dedup Detection** in Advanced Settings
- Lower the **threshold** if it's not catching similar entries (try 0.7)
- Use the `!merge` command to consolidate duplicates the AI already created

### "Auto-summary isn't firing!" ⏰

- Is Auto-Summary **enabled** in Advanced Settings?
- The counter is per-chat and counts user+AI messages. Check the counter in the UI.
- Auto-summary only triggers when there's at least one active TunnelVision lorebook
- The instruction fires on the NEXT generation after hitting the threshold. If you haven't sent a message since the threshold was hit, it hasn't triggered yet

---

## 🏗️ Architecture (For the Curious)

TunnelVision is modular by design. The index is lean, just the orchestrator wiring everything together:

```
index.js          : Init, events, wiring (lean orchestrator)
tree-store.js     : Tree data structure, CRUD, settings, serialization
tree-builder.js   : Auto-build trees from lorebook metadata or LLM
tool-registry.js  : ToolManager registration for all 8 tools
entry-manager.js  : Lorebook CRUD shared by all memory tools
ui-controller.js  : Settings panel, tree editor, drag-and-drop
diagnostics.js    : 30+ failure checks with auto-fixes
commands.js       : !command syntax interceptor
auto-summary.js   : Interval-based summary injection
activity-feed.js  : Real-time tool call visibility widget
tools/
  ├── search.js      : Channel navigation and entry retrieval
  ├── remember.js    : Create new entries (with dedup + schema design)
  ├── update.js      : Edit existing entries
  ├── forget.js      : Disable/delete entries
  ├── summarize.js   : Scene/event summaries with arcs
  ├── reorganize.js  : Move entries, create channels
  ├── merge-split.js : Merge or split entries
  └── notebook.js    : Private AI scratchpad (per-chat metadata)
```

Every module has a single responsibility. Every potential failure point has a diagnostic check. No tech debt. 🧹

---

## 🤝 Compatibility

- **🥕 BunnyMo**: Fully compatible. TunnelVision can manage BunnyMo lorebooks. Your character tags and psychological profiles get retrieved via reasoning instead of keywords.
- **🥕 CarrotKernel**: Works alongside CarrotKernel. They handle different things: CarrotKernel does character injection, TunnelVision does lorebook retrieval.
- **Any Lorebook**: TunnelVision works with ANY lorebook format. It doesn't care what's inside the entries. It just organizes and retrieves them intelligently.

---

---

*TunnelVision: Because your AI deserves better than Ctrl+F.* 📺🐰

*Built with ❤️ and way too much caffeine and sugar to be healthy.*
