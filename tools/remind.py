#!/usr/bin/env python3
"""One-shot reminder: push an ntfy note, then delete the schedule that fired it
(matched by label) so it never repeats. Cron can't express 'once' — this can."""
import argparse

import requests

NTFY = "http://127.0.0.1:8093/hub-jobs"
HUB = "http://127.0.0.1:8700"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--title", default="⏰ Reminder")
    p.add_argument("--message", required=True)
    p.add_argument("--self-destruct-label", default=None,
                   help="delete schedules with this label after firing")
    args = p.parse_args()

    requests.post(NTFY, data=args.message.encode("utf-8"),
                  headers={"Title": args.title.encode("utf-8", "ignore"),
                           "Priority": "high"}, timeout=15)
    print(f"reminded: {args.message}")

    if args.self_destruct_label:
        for s in requests.get(f"{HUB}/api/schedules", timeout=10).json():
            if s.get("label") == args.self_destruct_label:
                requests.delete(f"{HUB}/api/schedules/{s['id']}", timeout=10)
                print(f"self-destructed schedule {s['id']}")


if __name__ == "__main__":
    main()
