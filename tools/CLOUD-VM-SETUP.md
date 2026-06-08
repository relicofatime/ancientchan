# Upload /mlp/ images to archive.org via cloud VM

Total cost: $0 (uses Azure free trial $200 credit)

## 1. Create the VM (Azure)

- Go to https://portal.azure.com → Virtual Machines → Create
- Settings:
  - Name: `mlp-upload`
  - Region: East US (cheapest)
  - Image: Ubuntu 22.04 LTS
  - Size: Standard_D2s_v3 (2 vCPU, 8GB RAM)
  - Auth: password
  - Disk: add a 1500 GB Standard HDD data disk
- Create it

## 2. SSH in

- Azure portal → your VM → Connect → SSH
- Or: `ssh azureuser@<public-ip>`

## 3. Set up the data disk

```bash
sudo mkdir -p /mnt/data
sudo chown $USER /mnt/data
```

If the 1.5TB disk isn't auto-mounted, find and mount it:
```bash
lsblk                              # find the 1.5TB disk (e.g. sdc)
sudo mkfs.ext4 /dev/sdc            # format it
sudo mount /dev/sdc /mnt/data      # mount it
sudo chown $USER /mnt/data
```

## 4. Start tmux (so SSH disconnect won't kill the process)

```bash
sudo apt-get install -y tmux
tmux new -s upload
```

If you get disconnected, reconnect with: `tmux attach -t upload`

## 5. Get archive.org API keys

- Create account: https://archive.org/account/signup
- Get S3 keys: https://archive.org/account/s3.php

## 6. Run the upload script

```bash
export IA_ACCESS=your_access_key_here
export IA_SECRET=your_secret_key_here

curl -sL https://raw.githubusercontent.com/relicofatime/ancientchan/master/tools/archive-org-upload.sh | bash
```

The script handles everything: install deps, download torrent, sort files, compute hashes, upload to archive.org. It's fully resumable — if it dies, just re-run the same command.

## 7. Delete the VM

Once the upload log shows everything OK:

- Azure portal → Resource Groups → `mlp` → Delete resource group
- This stops all charges immediately

## After upload

Index file:
```
https://archive.org/download/4chan-mlp-archive-index/md5-index.json
```

Images:
```
https://archive.org/download/4chan-mlp-archive-YYYY-MM/TIMESTAMP.EXT
```

Months with >10k files are split into parts:
```
https://archive.org/download/4chan-mlp-archive-YYYY-MM-partN/TIMESTAMP.EXT
```

The ancientchan userscript uses the MD5 index to find dead /mlp/ images on archive.org.
