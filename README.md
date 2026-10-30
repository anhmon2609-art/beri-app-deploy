# Việc Nhà Của Bé (deploy mirror)

Public deploy source for Render. **No live family data** is kept here.

- App/API code + Android wrapper
- Production data is restored at runtime from the **private** repo snapshot via `GITHUB_PERSIST_*` env on Render
- Stable URL: https://viec-nha-cua-be.onrender.com

Do not commit `beri.db`, SQL dumps, or snapshots to this repository.
