-- PlaySapien 0010: the HAVEN26 promotion code.
--
-- Sapien through the whole of 1 November 2026, UTC: grants_until is
-- 2026-11-02T00:00:00Z, the first instant it no longer applies -- the same end as
-- the launch trial (0003), so the two codes can be spoken of as one date. Anyone
-- can redeem it, once, until it runs out. Like every promotion code it is meant
-- to be handed out, so it sits here in the repository on purpose.
INSERT INTO promo_codes (code, plan, grants_until, redeem_until, max_uses, uses, active, note, created_at)
VALUES ('HAVEN26', 'sapien', 1793577600, NULL, NULL, 0, 1,
        'HAVEN26: Sapien through 1 Nov 2026', 1792584000);
