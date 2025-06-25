const mainView = document.getElementById('mainView');
const addView = document.getElementById('addView');
const projectSelect = document.getElementById('projectSelect');
const syncButton = document.getElementById('syncButton');
const addButton = document.getElementById('addButton');
const saveButton = document.getElementById('saveButton');
const cancelButton = document.getElementById('cancelButton');
const projectNameInput = document.getElementById('projectNameInput');
const driveUrlInput = document.getElementById('driveUrlInput');
const linkUrlGroup = document.getElementById('linkUrlGroup');
const statusDiv = document.getElementById('status');

let overleafProjectId = null;

function setMainUIState(isBusy, message) {
    statusDiv.textContent = message;
    const shouldDisable = isBusy || !overleafProjectId;
    syncButton.disabled = shouldDisable || projectSelect.value === '';
    addButton.disabled = shouldDisable;
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

function populateProjectList(projects) {
    projectSelect.innerHTML = '';
    if (projects && projects.length > 0) {
        projects.forEach(proj => {
            const option = new Option(proj.projectName, proj.driveFileId);
            option.dataset.project = JSON.stringify(proj);
            projectSelect.appendChild(option);
        });
        syncButton.disabled = false;
    } else {
        const option = new Option('-- No projects linked yet --', '');
        projectSelect.appendChild(option);
        syncButton.disabled = true;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    setMainUIState(true, 'Initializing...');
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.url?.includes("overleaf.com/project/")) {
            overleafProjectId = tab.url.split('/project/')[1].split('/')[0];
        }

        if (overleafProjectId) {
            addButton.disabled = false;
            statusDiv.textContent = 'Fetching config from Google Drive...';
            const response = await chrome.runtime.sendMessage({ action: 'get_config' });
            if (!response.success) throw new Error(response.error);
            populateProjectList(response.data.projects);
            statusDiv.textContent = 'Ready.';
        } else {
            setMainUIState(true, 'Go to an Overleaf project page to use this.');
            projectSelect.innerHTML = '<option>-- N/A --</option>';
        }
    } catch (error) {
        setMainUIState(true, `Error: ${error.message}`);
    }
});

addButton.addEventListener('click', () => {
    projectNameInput.value = '';
    driveUrlInput.value = '';
    showView('addView');
});

cancelButton.addEventListener('click', () => showView('mainView'));

document.querySelectorAll('input[name="linkMethod"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        linkUrlGroup.style.display = e.target.value === 'link' ? 'block' : 'none';
    });
});

saveButton.addEventListener('click', async () => {
    const projectName = projectNameInput.value.trim();
    if (!projectName) {
        alert("Project name cannot be empty.");
        return;
    }

    setMainUIState(true, 'Saving project...');
    const linkMethod = document.querySelector('input[name="linkMethod"]:checked').value;

    const message = {
        action: 'add_project',
        projectName,
        overleafProjectId
    };

    if (linkMethod === 'link') {
        const driveUrl = driveUrlInput.value;
        if (driveUrl.includes('/d/')) {
            message.driveFileId = driveUrl.split('/d/')[1].split('/')[0];
        } else if (driveUrl.includes('id=')) {
            try { message.driveFileId = new URL(driveUrl).searchParams.get("id"); } catch (e) {}
        }
        if (!message.driveFileId) {
            alert("Invalid or unrecognized Google Drive link format.");
            setMainUIState(false, 'Ready.');
            return;
        }
    } else {
        message.createNew = true;
    }

    try {
        const response = await chrome.runtime.sendMessage(message);
        if (!response.success) throw new Error(response.error);
        populateProjectList(response.data.projects);
        projectSelect.value = response.newFileId || message.driveFileId;
        statusDiv.textContent = 'Project saved successfully!';
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        addButton.disabled = false;
        showView('mainView');
    }
});

syncButton.addEventListener('click', async () => {
    const selectedOption = projectSelect.options[projectSelect.selectedIndex];
    if (!selectedOption || !selectedOption.dataset.project) {
        alert("Please select a project to sync.");
        return;
    }
    const project = JSON.parse(selectedOption.dataset.project);

    setMainUIState(true, `Syncing '${project.projectName}'...`);
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: () => document.querySelector('a[aria-label="Download PDF"]')?.href
        });
        const pdfUrl = results?.[0]?.result;
        if (!pdfUrl) throw new Error("Could not find PDF link. Please recompile in Overleaf.");

        const response = await chrome.runtime.sendMessage({
            action: 'upload',
            pdfUrl: pdfUrl,
            driveFileId: project.driveFileId,
            newFileName: project.projectName + '.pdf'
        });
        if (!response.success) throw new Error(response.error);
        statusDiv.textContent = 'Sync successful!';
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        setMainUIState(false, 'Ready.');
    }
});