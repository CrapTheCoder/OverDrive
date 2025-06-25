const CONFIG_FILE_NAME = 'overdrive-config.json';
let config_file_id = null;

async function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!token) return reject(new Error("Authorization failed. Please try again."));
            resolve(token);
        });
    });
}

async function findOrCreateConfigFile(token) {
    if (config_file_id) return { id: config_file_id };
    const query = encodeURIComponent(`name='${CONFIG_FILE_NAME}' and 'root' in parents and trashed=false`);
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id, trashed)`;
    const searchRes = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const searchData = await searchRes.json();
    if (!searchRes.ok) throw new Error(searchData.error?.message || "API search failed.");

    if (searchData.files && searchData.files.length > 0) {
        config_file_id = searchData.files[0].id;
        return { id: config_file_id };
    }

    const metadata = { name: CONFIG_FILE_NAME, mimeType: 'application/json', parents: ['root'] };
    const createUrl = `https://www.googleapis.com/drive/v3/files`;
    const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata)
    });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData.error?.message || "Failed to create config file.");
    config_file_id = createData.id;
    return { id: config_file_id, isNew: true };
}

async function readConfigFile(token, fileId) {
    const getUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.status === 404) { config_file_id = null; throw new Error("Config file not found."); }
    if (!res.ok) throw new Error("Could not download config file.");
    try { return await res.json(); } catch (e) { return { projects: [] }; }
}

async function updateConfigFile(token, fileId, contentObject) {
    const updateUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
    const res = await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(contentObject, null, 2)
    });
    if (res.status === 404) { config_file_id = null; throw new Error("Config file not found."); }
    if (!res.ok) throw new Error("Could not update config file.");
}

chrome.action.onClicked.addListener(async (tab) => {
    if (tab.url?.startsWith("https://www.overleaf.com/project/")) {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        await chrome.sidePanel.setOptions({
            tabId: tab.id,
            enabled: !!(tab.url?.startsWith("https://www.overleaf.com/project/"))
        });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handleRequest = async () => {
        try {
            const token = await getAuthToken(true);
            const {id: fileId, isNew} = await findOrCreateConfigFile(token);
            let config = isNew ? {projects: []} : await readConfigFile(token, fileId);

            switch (request.action) {
                case 'get_config':
                    return {success: true, data: config};

                case 'add_project':
                    let newFileId = request.driveFileId;
                    if (request.createNew) {
                        const createMetadata = {name: request.projectName + '.pdf', mimeType: 'application/pdf'};
                        const createRes = await fetch(`https://www.googleapis.com/drive/v3/files`, {
                            method: 'POST',
                            headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
                            body: JSON.stringify(createMetadata)
                        });
                        const createData = await createRes.json();
                        if (!createRes.ok) throw new Error(createData.error.message);
                        newFileId = createData.id;
                    }
                    config.projects = config.projects.filter(p => p.overleafProjectId !== request.overleafProjectId);
                    config.projects.push({
                        projectName: request.projectName,
                        overleafProjectId: request.overleafProjectId,
                        driveFileId: newFileId
                    });
                    await updateConfigFile(token, fileId, config);
                    return {success: true, data: config, newFileId};

                case 'upload':
                    const pdfResponse = await fetch(request.pdfUrl);
                    if (!pdfResponse.ok) throw new Error(`Failed to download PDF.`);
                    const pdfBlob = await pdfResponse.blob();

                    const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${request.driveFileId}?uploadType=media`;
                    const uploadRes = await fetch(uploadUrl, {
                        method: 'PATCH',
                        headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/pdf'},
                        body: pdfBlob
                    });
                    if (!uploadRes.ok) throw new Error((await uploadRes.json()).error.message);

                    if (request.newFileName) {
                        const metadataUrl = `https://www.googleapis.com/drive/v3/files/${request.driveFileId}`;
                        await fetch(metadataUrl, {
                            method: 'PATCH',
                            headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
                            body: JSON.stringify({name: request.newFileName})
                        });
                    }
                    return {success: true};

                default:
                    return {success: false, error: 'Unknown action'};
            }
        } catch (error) {
            console.error("Background Error:", error);
            return {success: false, error: error.message};
        }
    };
    handleRequest().then(sendResponse);
    return true;
});
