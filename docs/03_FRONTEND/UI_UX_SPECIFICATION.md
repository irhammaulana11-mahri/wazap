# UI/UX Specification

## Visual direction

Professional SaaS dashboard, responsive desktop-first but usable on
tablet/mobile. Clear status colors, compact data tables, accessible
contrast, consistent spacing and typography.

## Navigation

1.  Overview
2.  WhatsApp Sessions
3.  Messages
4.  Contacts
5.  Chat History
6.  Templates
7.  Webhooks
8.  API Keys
9.  Usage & Limits
10. Team Members
11. Settings

Platform admin has a separate protected area.

## Dashboard

-   Active/disconnected sessions.
-   Message totals by status.
-   Queue depth and recent activity.
-   Session health.
-   Usage summary.
-   Avoid showing fabricated/demo values in production.

## Session management

-   Add session.
-   Display QR/pairing flow.
-   Show lifecycle status and last connected time.
-   Disconnect/reconnect/delete with confirmation.
-   Do not display credentials or raw auth data.

## Messaging

-   Send form with session selector.
-   Recipient validation.
-   Text/media modes.
-   Job status and message history.
-   Clearly distinguish accepted, sent, delivered, read, failed and
    unknown.

## Required states

Every page must implement loading, empty, error, permission denied, and
success states.
