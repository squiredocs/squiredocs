---
slug: appearance
title: Appearance
description: The Light, Dark, and System theme settings in Squire Docs, and how they affect the app and your documents.
order: 11
---

Squire Docs has a theme control in the user profile menu with three settings. This page covers what each does.

## Light, Dark, and System

- **Light**: the light theme.
- **Dark**: the dark theme.
- **System**: the default. It follows your operating system's light or dark preference, and it changes live when your system does, with no reload.

The control shows the active setting and appears in the user profile menu on every signed-in screen.

Your choice is saved on the device you set it on, and it is applied before the page first paints, so you do not see a flash of the wrong theme when a page loads. This holds whether you are signed in or out. The setting is per device: it is not yet synced to your account across devices.

## What the theme covers

The theme applies to both the app's own interface and the document editing surface. In dark mode, the document canvas is dark too.

A few things stay fixed so content reads as intended:

- **Author-set colors**: text and background colors you or an agent chose render exactly as set, in both themes.
- **Mermaid diagrams**: in dark mode these are inverted on screen so they read on a dark background. This is a display effect only. The stored diagram, exports, clipboard copies, and printouts stay light.
- **SVG blocks and images**: SVG blocks keep a light backing, and images render as they are.
- **Printing**: printed output is always light, from either theme.

## What the theme does not do

Switching themes only changes how things look. It never writes to your documents, creates a version, or affects collaboration. Everyone editing a document can be on a different theme without changing anything about the document itself.
