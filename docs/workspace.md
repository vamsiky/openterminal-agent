# Workspace

The web app's main area is a set of **panes**. Each pane holds one or more **tabs**, and each tab is one panel (chart, quote, stock details, and so on). This page describes how they work and where the layout is kept.

The code is in `web/components/workspace/` (panes, rail, pop-out window), `web/components/Workspace.tsx` (dragging and resizing) and `web/store/terminal.ts` (state).

## Panes and tabs

- **Move** a pane by its grip (the dots in the pane header). Double-click the grip to maximize or restore it.
- **Resize** from any of the 4 edges or 4 corners. A pane is at least 240 × 140 px.
- **Snap.** Edges and the workspace border pull a moving or resizing pane within 10 px. Drop a pane with the pointer at a workspace edge to fill that half; at a corner, fill that quarter. An amber outline previews the spot while you drag.
- **Snap menu** (the window icon in the header): left, right, top and bottom half; four quarters; left two-thirds; right third; full workspace.
- **Tile panes** (top bar): arranges all panes in an even grid.
- **Maximize** (the square icon, or double-click the grip) fills the workspace. Restore puts the pane back where it was.
- **Focus.** Clicking a pane focuses it and brings it to the front. New panels and the ⌥ shortcuts go into the focused pane.
- **Tabs.** Click a tab to show it. The × on a tab removes that panel from the layout. The tab strip scrolls with the mouse wheel.
- **Symbol tag and link.** Panels that show a stock have a ticker tag. A linked panel (the chain icon, lit amber) follows the active symbol. Click the tag to give the panel its own ticker; that unlinks it.

Panes keep their stacking order by `z` value only. Their place in the list never changes, so a click inside a pane does not rebuild it.

## Adding panels

The **Panels** rail on the left lists every panel, grouped as Markets, Research, Ideas & trading, and Tools. Each row shows how many copies are open. Clicking a row opens a menu:

- Add as a tab in the focused pane
- New pane to the right
- New pane below
- Open in its own window

The rail collapses to a column of icons. Clicking an icon there opens the same menu beside it. Click outside it, or press Escape, to close it.

### Keyboard

| Keys | Action |
|---|---|
| ⌥1 to ⌥9 (Option + digit) | Add a panel as a tab in the focused pane |
| ⌘K (or Ctrl+K) | Open the symbol search |

The ⌥ keys map to: 1 Chart, 2 Quote, 3 News, 4 Screener, 5 Heatmap, 6 Crypto, 7 Option chain, 8 Portfolio, 9 AI assist. The shortcut always adds a new tab; it does not switch to an existing one. Other panels have no shortcut.

## Pop-out windows

A tab or pane can open in its own browser window (the window icon in the header, or "Open in its own window" in the rail). The window shows only that panel, at `/window?w=<id>`, and can be moved to another monitor like any window.

- **Docking back.** Closing the window puts the panel back as a tab in the focused pane. The window's **Dock back** button does the same thing.
- **Blocked pop-ups.** If the browser blocks the window, the panel is added to the workspace instead.
- **Heartbeat.** A pop-out window writes a timestamp to localStorage every 2 s. If the main window sees no timestamp for 7 s (the browser quit, or the window crashed), it docks the panel back. The main window checks every 5 s.
- **Sync.** Every window reads the same localStorage store. When one window writes it, the other windows get a `storage` event and reload the store. The active symbol, watchlists and panel state therefore stay the same in each window.
- **Reset layout** also closes the pop-out windows, because their panels are no longer in the layout.

## Layout storage

The layout is saved in localStorage under the key `openterminal-workspace`. It holds the panes and their tabs, the open windows, the watchlists, the active symbol, the 20 most recent symbols, whether the rail and the watchlist are open, and the watchlist width. Transient state, such as the ⌘K palette being open, is not saved.

The store version is **2**.

- **Version 0 to 1.** The single watchlist became a list named `default`.
- **Version 1 to 2.** The old 12-column grid layout (`widgets` and `layout`) is dropped. The workspace starts from the default layout. Watchlists and the active symbol are kept.

The default layout is: chart at top left; stock details below it; quote at top right; research & reports and ideas as two tabs below the quote. **Reset layout** returns to this layout.

## Stock details

The Stock details panel (`web/components/widgets/DetailsWidget.tsx`) follows the active symbol. Each section below is a tab in the panel, with sub-tabs where listed. Every section shows a loading state, an error state, or a "no data" message.

| Section | Sub-tabs | Data |
|---|---|---|
| News | | `/api/research/:symbol/news` |
| Comments | | Message only (see below) |
| Options | | Compact chain: `/api/options/:symbol` |
| Bonds | | Message only (see below) |
| Financials | Forecast · Income statement · Balance sheet · Cash flow · Earnings history | Forecast: `/api/research/:symbol/estimates`. Statements: `/api/research/:symbol/statements?type=…&period=quarter`. History: `/api/earnings-history/:symbol` |
| Analysis | Analysts · Short selling · Institutions · Order flow · ETF weighting | Analysts: `/api/research/:symbol/analysts`, price from `/api/quotes`. Short selling: `/api/short-volume/:symbol`. Institutions: `/api/research/:symbol/institutional`. ETF weighting: `/api/research/:symbol/etf-exposure`. Order flow: message only |
| Filings & releases | SEC filings · Press releases · Insider filings | Filings: `/api/research/:symbol/filings`. Press releases: `/api/research/:symbol/press-releases`. Insider filings: `/api/insider/:symbol` |
| Corporate actions | Dividends · Splits · Insider activity | Dividends: `/api/research/:symbol/profile`. Splits: message only. Insider activity: `/api/insider/:symbol` |
| Brief | Profile · Key executives | `/api/research/:symbol/profile` |

The `/api/research/:symbol/…` routes need `FMP_API_KEY`. See the [Research API](research-api.md) notes.

### Sections with a "no data" message

Some sections show a fixed message instead of data. The reason is either that no provider has the data, or that the app does not load it yet.

- **Comments.** No data provider has a community feed.
- **Bonds.** The app has no corporate-bond source.
- **Order flow.** The app does not compute it. It needs every trade classified by size, which could come from the SIP trade feed later.
- **Splits.** The split history is not loaded. Price charts are already split-adjusted.
- **Dividend history.** The ex-dates and pay dates are not loaded. The annual dividend and yield come from the profile.
- **Short selling.** Short interest and days to cover (FINRA's twice-monthly report) are not loaded. The section shows daily short-sale volume from FINRA.

Two other empty states show data-driven messages: "No key executives listed" and "No … for {symbol}", which appear when the provider returns nothing.

## Option chain

The full chain (the **Option chain** panel) and the compact chain in Stock details both use `GET /api/options/:symbol`.

- **Refresh.** The panel refetches every 15 s while it is mounted. The server caches each chain for 15 s too.
- **Expiry.** Without a chosen expiry, the nearest one after today is loaded. Same-day contracts have no IV or greeks, so the API's own default is not used.
- **Open interest** is not shown. Alpaca's market-data feed does not include it, so the chain route returns it as null. The options sweep reads open interest from Alpaca's contract data for its own checks; see [Options data](options-data.md).

The compact chain shows the 10 strikes nearest the price for the nearest expiry, with an **Open full chain** button.

## Chart

The Chart panel's range summary line sits above the plot. It shows the change, open, close, high and low for the range. Hover over the plot and the same line shows the bar under the pointer. The plot also has high and low markers for the bars in view.
