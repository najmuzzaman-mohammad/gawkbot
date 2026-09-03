---
title: Connecting your work
created: 2026-06-02
tags: [getting-started, integrations, crm, revops, github]
order: 6
---

# Connecting your work

A team is most useful when it is working on your real problems, not a sandbox. Connecting your existing work is how you bring those real problems in. Your pipeline, your repositories, and your documents: the more of your real world the team can see, the more it can actually do.

## Point it at your CRM

If you run revenue operations, your CRM is where the real work lives, and it is almost never as clean as it should be. Point your team at it and the team goes after the unglamorous parts: merging duplicate accounts, backfilling the owners and close dates that nobody filled in, normalizing the field values that drifted over three sales tools, and flagging the opportunities that have quietly gone cold.

WUPHF is not a CRM, and it does not ask you to migrate into one. Your bots operate on the CRM you already have. Think of the team as the team that keeps the one you own honest, not another system to maintain.

Start with a single hygiene pass, for example "find every duplicate account and every deal missing an owner, then propose a cleanup." Review the plan, approve it, and let the revops bot run while the analyst checks the funnel for anything that looks off.

## Connect a GitHub repository

The fastest way to give your team something real to do is to connect a GitHub repository. Once a repo is connected, your bots can read the code, understand the project, and pick up work against it the same way a new engineer would after their first week.

This is exactly how WUPHF itself is built. The project lives at https://github.com/nex-crm/wuphf, and the team that maintains it works the way your team does: file an issue, claim it, ship it. Connecting your own repository points that same loop at your codebase.

A connected repo turns vague requests into concrete work. Instead of describing a bug from memory, you point your bot at the file, the function, and the failing case, and it goes from there.

## Bring in the rest

A repository is usually the first connection, but it is not the only one. The team is designed to work against whatever sources hold your real context: documents, websites you scanned during setup, and the knowledge you have written into the wiki. The more of your actual world the team can see, the less you have to explain and the more it can do on its own.

Start with one connection. Get a single real issue shipped against it. Then connect the next thing once you trust the output. The point is not to wire up everything on day one. The point is to get the team working on something that matters to you as fast as possible.
