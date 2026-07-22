# Invoice parser — requirements

## Overview

Parse PDF and image invoices into structured `{ vendor, date, lineItems, total }`
records. This is the Kiro spec the onboard flow should offer first.

## Requirements

- Accept PDF and common image formats.
- Extract vendor, invoice date, line items, and total.
- Flag low-confidence extractions for human review.

## Status

- [ ] PDF ingestion
- [ ] image OCR
- [ ] field extraction
- [ ] confidence flagging
