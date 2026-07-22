# Widget sync spec

## Overview

The widget service pulls widget definitions from the registry and renders them
to SVG. This spec is the source of truth for the sync behavior.

## Requirements

- Pull widget definitions on a 5-minute interval.
- Render each definition to SVG, caching by content hash.
- Expose `GET /widgets/:id.svg` returning the cached render.

## Status

- [ ] interval puller
- [ ] SVG renderer
- [ ] cache-by-hash
- [ ] HTTP endpoint
