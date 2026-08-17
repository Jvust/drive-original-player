# Cross-Project Hardware Baseline

Updated: 2026-08-18

## 1号 / User environment
- Computer: ASUS TUF Gaming A15 FA507NU / 华硕天选4
- CPU: AMD Ryzen 7 7735H
- GPU: NVIDIA GeForce RTX 4050 Laptop GPU, 6141 MB reported, treated as 6 GB VRAM class
- RAM: 16 GB, 5600 MHz reported
- Storage: 512 GB WD PC SN740 + user-added 1 TB SSD, about 1.5 TB physical total
- OS: Windows 11 Home Chinese 64-bit
- Phone: Xiaomi 14 / Snapdragon 8 Gen 3 / 16 GB physical RAM / 1 TB

## 2号 / Friend environment
- Computer: Lenovo Legion Y9000P IRX9
- CPU: Intel Core i9-14900HX
- GPU: NVIDIA GeForce RTX 4060 Laptop GPU 8 GB
- RAM: 32 GB, 5600 MT/s reported
- Storage: 1 TB Samsung SSD
- Phone: Xiaomi 14 Pro / Snapdragon 8 Gen 3 / 16 GB physical RAM + 6 GB memory extension / 1 TB
- Model-sizing rule: the +6 GB extension is not physical RAM; use 16 GB as the primary RAM budget.

## Notes
- TUF: use conservative local-model sizing, especially 4B-class vision workloads.
- Y9000P: preferred for heavier local inference and larger experiments.
