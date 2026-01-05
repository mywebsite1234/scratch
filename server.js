const express = require('express');
const fetch = require('node-fetch');
const JSZip = require('jszip');
const app = express();
const port = 3000;

app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1>Scratch 3 Downloader</h1>
        <p>Paste a Scratch or TurboWrap link below.</p>
        <form action="/download" method="POST">
          <input type="text" name="projectLink" placeholder="https://scratch.mit.edu/projects/..." style="width: 300px; padding: 10px;" required>
          <br><br>
          <button type="submit">Download .sb3</button>
        </form>
      </body>
    </html>
  `);
});

// Helper: Tries to fetch an asset from multiple possible Scratch CDNs
async function fetchAsset(fileName) {
    const urls = [
        `https://assets.scratch.mit.edu/internalapi/asset/${fileName}/get/`,
        `https://cdn.assets.scratch.mit.edu/internalapi/asset/${fileName}/get/`
    ];

    for (const url of urls) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Referer': 'https://scratch.mit.edu/'
                }
            });
            if (response.ok) {
                return await response.buffer();
            }
        } catch (e) {
            // Try next URL
        }
    }
    throw new Error(`Failed to download ${fileName}`);
}

app.post('/download', async (req, res) => {
  const link = req.body.projectLink;
  const idMatch = link.match(/\d+/);
  if (!idMatch) return res.send("Error: Could not find a project ID.");
  
  const projectId = idMatch[0];
  console.log(`Processing ID: ${projectId}`);

  try {
    // 1. Get Token
    const metadataResponse = await fetch(`https://api.scratch.mit.edu/projects/${projectId}`);
    if (!metadataResponse.ok) throw new Error("Project not found or unshared.");
    const metadata = await metadataResponse.json();
    const token = metadata.project_token;

    // 2. Fetch Project Data
    const projectUrl = `https://projects.scratch.mit.edu/${projectId}?token=${token}`;
    const projectResponse = await fetch(projectUrl);
    if (!projectResponse.ok) throw new Error("Failed to fetch project data.");
    
    const projectBuffer = await projectResponse.buffer();

    // 3. CHECK: Is it already a ZIP file?
    if (projectBuffer[0] === 0x50 && projectBuffer[1] === 0x4B) {
        console.log("Server returned a complete .sb3 file directly.");
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${projectId}.sb3`);
        return res.send(projectBuffer);
    }

    // 4. Parse & Sanitize JSON (The "Nuclear" Fix)
    console.log("Server returned JSON. Running sanitization...");
    const projectJson = JSON.parse(projectBuffer.toString());

    if (projectJson.targets) {
        projectJson.targets.forEach(target => {
            if (target.blocks) {
                Object.values(target.blocks).forEach(block => {
                    if (!block.inputs) return;
                    for (const key in block.inputs) {
                        const input = block.inputs[key];
                        if (!Array.isArray(input)) {
                            block.inputs[key] = [1, null]; 
                            continue;
                        }
                        while (input.length < 2) {
                            input.push(null);
                        }
                        if (Array.isArray(input[1]) && input[1].length === 0) {
                            input[1] = null;
                        }
                    }
                });
            }
        });
    }

    const zip = new JSZip();
    zip.file('project.json', JSON.stringify(projectJson));

    // 5. Asset Downloading (With Headers & Fallbacks)
    const assets = [];
    const targets = projectJson.targets || [];
    targets.forEach(t => {
      if (t.costumes) t.costumes.forEach(c => assets.push(c));
      if (t.sounds) t.sounds.forEach(s => assets.push(s));
    });

    const uniqueAssetsMap = new Map();
    assets.forEach(asset => {
        const fileName = asset.md5ext || `${asset.assetId}.${asset.dataFormat}`;
        uniqueAssetsMap.set(fileName, asset);
    });

    const uniqueAssetsList = Array.from(uniqueAssetsMap.entries());
    console.log(`Found ${uniqueAssetsList.length} assets to download.`);

    // Download in chunks
    const CHUNK_SIZE = 10;
    for (let i = 0; i < uniqueAssetsList.length; i += CHUNK_SIZE) {
        const chunk = uniqueAssetsList.slice(i, i + CHUNK_SIZE);
        
        await Promise.all(chunk.map(async ([fileName, asset]) => {
            try {
                const buffer = await fetchAsset(fileName);
                zip.file(fileName, buffer);
                console.log(`Downloaded: ${fileName}`);
            } catch (e) {
                console.error(`ERROR: Could not download asset ${fileName}`);
            }
        }));
    }

    const finalBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=${projectId}.sb3`);
    res.send(finalBuffer);

  } catch (error) {
    console.error(error);
    res.send(`Error: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});