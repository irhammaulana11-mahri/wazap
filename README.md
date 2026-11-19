# WhatsApp Gateway --- AI Agent Development Kit

**Versi:** 1.0\
**Status:** Baseline desain dan pengembangan\
**Bahasa dokumentasi:** Indonesia

## Tujuan

Paket ini menjadi sumber acuan bersama untuk membangun platform
Multi-Tenant WhatsApp Gateway dengan model self-service, dynamic
session, dashboard web, dan REST API.

## Cara menggunakan

1.  Letakkan folder `docs/` dan file `README.md` di root repository.
2.  Sebelum bekerja, setiap AI Agent wajib membaca:
    -   `docs/00_PROJECT/PROJECT_OVERVIEW.md`
    -   `docs/00_PROJECT/PRODUCT_REQUIREMENTS.md`
    -   `docs/00_PROJECT/ARCHITECTURE.md`
    -   `docs/00_PROJECT/DECISION_LOG.md`
    -   `docs/08_AI_AGENTS/DOCUMENTATION_RULES.md`
3.  Agent khusus wajib membaca prompt dan dokumen domainnya.
4.  Jangan mengubah keputusan arsitektur tanpa mencatat proposal dan
    meminta persetujuan.
5.  Setiap pekerjaan harus memperbarui progress, changelog, dan kontrak
    terkait.
6.  Agent tidak boleh mengklaim pekerjaan selesai jika belum menjalankan
    pemeriksaan yang relevan.

## Urutan agent yang direkomendasikan

  -----------------------------------------------------------------------
  Urutan                  Agent                   Tanggung jawab
  ----------------------- ----------------------- -----------------------
  1                       Master / Architect      Menjaga scope,
                                                  keputusan, dan
                                                  pembagian pekerjaan

  2                       Backend                 Database, API, session
                                                  manager, engine, queue

  3                       Frontend                Dashboard dan integrasi
                                                  API

  4                       Integration             Memastikan kontrak
                                                  backend--frontend dan
                                                  event realtime cocok

  5                       QA                      Test fungsional,
                                                  keamanan, isolasi
                                                  tenant, beban

  6                       Documentation           Memastikan dokumen
                                                  sesuai implementasi
                                                  aktual
  -----------------------------------------------------------------------

## Status pekerjaan

Gunakan status: `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`,
`DONE`.

## Prinsip utama

Dokumentasi adalah kontrak kerja. Jika implementasi dan dokumentasi
berbeda, agent harus mengidentifikasi perbedaannya dan memperbarui
dokumen setelah mendapat persetujuan yang diperlukan.
