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

    // 2. Fetch Project Data (Raw Buffer)
    const projectUrl = `https://projects.scratch.mit.edu/${projectId}?token=${token}`;
    const projectResponse = await fetch(projectUrl);
    if (!projectResponse.ok) throw new Error("Failed to fetch project data.");
    
    // We get the raw data first, then check what it is
    const projectBuffer = await projectResponse.buffer();

    // 3. CHECK: Is it already a ZIP file? (Starts with "PK")
    if (projectBuffer[0] === 0x50 && projectBuffer[1] === 0x4B) {
        console.log("Server returned a complete .sb3 file directly.");
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename=${projectId}.sb3`);
        return res.send(projectBuffer);
    }

    // 4. If not a ZIP, it's JSON. Parse it and build the file manually.
    console.log("Server returned JSON. Building .sb3 manually...");
    const projectJson = JSON.parse(projectBuffer.toString());

    const zip = new JSZip();
    zip.file('project.json', projectBuffer); // Save the JSON we just downloaded

    const targets = projectJson.targets;
    const assets = [];
    targets.forEach(t => {
      if (t.costumes) t.costumes.forEach(c => assets.push(c));
      if (t.sounds) t.sounds.forEach(s => assets.push(s));
    });

    // Remove duplicates
    const uniqueAssets = [...new Map(assets.map(item => [item.md5ext, item])).values()];

    // Download all assets
    await Promise.all(uniqueAssets.map(async (asset) => {
      const assetUrl = `https://assets.scratch.mit.edu/internalapi/asset/${asset.md5ext}/get/`;
      const response = await fetch(assetUrl);
      const buffer = await response.buffer();
      zip.file(asset.md5ext, buffer);
    }));

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