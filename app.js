/**
 * PDRM Selangor Crime Analytics Dashboard - Application Script
 * Integrates data fetching, UI updates, table operations, and Apache ECharts.
 */

// Global State
let rawData = [];
let filteredData = [];
let selangorGeoJSON = null;
let chartInstances = {};
let tableState = {
    searchQuery: '',
    categoryFilter: 'ALL',
    currentPage: 1,
    pageSize: 10,
    sortBy: 'reported',
    sortOrder: 'desc'
};

// District → IPD mapping (from GeoJSON properties)
const DISTRICT_IPD_MAP = {
    'Petaling':       ['IPD Petaling Jaya', 'IPD Shah Alam', 'IPD Subang Jaya', 'IPD Sungai Buloh'],
    'Klang':          ['IPD Klang Utara', 'IPD Klang Selatan'],
    'Gombak':         ['IPD Gombak', 'IPD Ampang Jaya'],
    'Hulu Langat':    ['IPD Kajang', 'IPD Serdang'],
    'Sepang':         ['IPD Sepang'],
    'Kuala Langat':   ['IPD Kuala Langat'],
    'Kuala Selangor': ['IPD Kuala Selangor'],
    'Hulu Selangor':  ['IPD Hulu Selangor'],
    'Sabak Bernam':   ['IPD Sabak Bernam']
};

// Colors mapping matching the CSS variables
const COLORS = {
    cyan: '#00f0ff',
    green: '#39ff14',
    yellow: '#ffd700',
    red: '#ff3131',
    orange: '#ff781f',
    purple: '#8b5cf6',
    pink: '#ec4899',
    muted: '#6b7280',
    gridLine: 'rgba(255, 255, 255, 0.05)',
    axisText: '#9ca3af'
};

function updateThemeColors() {
    const isLight = document.body.classList.contains('dashboard-theme-light');
    if (isLight) {
        COLORS.cyan = '#0284c7';
        COLORS.green = '#16a34a';
        COLORS.yellow = '#ca8a04';
        COLORS.red = '#dc2626';
        COLORS.orange = '#ea580c';
        COLORS.purple = '#7c3aed';
        COLORS.pink = '#db2777';
        COLORS.muted = '#475569';
        COLORS.gridLine = 'rgba(0, 0, 0, 0.06)';
        COLORS.axisText = '#475569';
    } else {
        COLORS.cyan = '#00f0ff';
        COLORS.green = '#39ff14';
        COLORS.yellow = '#ffd700';
        COLORS.red = '#ff3131';
        COLORS.orange = '#ff781f';
        COLORS.purple = '#8b5cf6';
        COLORS.pink = '#ec4899';
        COLORS.muted = '#6b7280';
        COLORS.gridLine = 'rgba(255, 255, 255, 0.05)';
        COLORS.axisText = '#9ca3af';
    }
}

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
    // Check login session - redirect to login if not authenticated
    const token = sessionStorage.getItem('pdrm_token');
    if (!token) {
        window.location.href = 'login.html';
        return;
    }

    // Restore theme state
    const savedTheme = localStorage.getItem('pdrm_theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('dashboard-theme-light');
        const themeIcon = document.querySelector('#btn-theme-toggle i');
        if (themeIcon) {
            themeIcon.className = 'fas fa-moon';
        }
        updateThemeColors();
    }

    initClock();
    fetchDashboardData();
    setupEventListeners();
    setupUploadModal();
    setupChangePasswordModal();
    setupAddDataModal();
    setupExportCSV();
    setupLogout();
});

// 1. Live Clock & Date Widget (Malaysian / System time)
function initClock() {
    const timeEl = document.getElementById('live-time');
    const dateEl = document.getElementById('live-date');
    
    const updateTime = () => {
        const now = new Date();
        
        // Time format: HH:MM:SS AM/PM
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12; // hour '0' should be '12'
        const hoursStr = String(hours).padStart(2, '0');
        
        timeEl.textContent = `${hoursStr}:${minutes}:${seconds} ${ampm}`;
        
        // Date format: e.g. 08 Julai 2026
        const days = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'];
        const months = [
            'Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 
            'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember'
        ];
        
        const dayName = days[now.getDay()];
        const dayNum = now.getDate();
        const monthName = months[now.getMonth()];
        const year = now.getFullYear();
        
        dateEl.textContent = `${dayName}, ${dayNum} ${monthName} ${year}`;
    };
    
    updateTime();
    setInterval(updateTime, 1000);
}

// 2. Fetch Data from Python Backend API (loads CSV data + GeoJSON in parallel)
// Helper to parse standard CSV lines with quote support
function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    return lines.map(line => {
        let insideQuote = false;
        let entries = [];
        let entry = '';
        for (let i = 0; i < line.length; i++) {
            let char = line[i];
            if (char === '"') {
                insideQuote = !insideQuote;
            } else if (char === ',' && !insideQuote) {
                entries.push(entry.trim());
                entry = '';
            } else {
                entry += char;
            }
        }
        entries.push(entry.trim());
        return entries;
    }).filter(row => row.length > 0 && row.some(cell => cell !== ''));
}

// Helper to map spreadsheet/CSV rows dynamically to structured PDRM objects
function mapRowsToObjects(rows) {
    if (rows.length < 2) return [];
    
    // Lowercase and trim headers for robust flexible column matching
    const headers = rows[0].map(h => String(h || '').toLowerCase().trim());
    
    // Find column indices
    let yearIdx = headers.findIndex(h => h.includes('tahun') || h.includes('year'));
    let ipdIdx = headers.findIndex(h => h.includes('ipd') || h.includes('daerah') || h.includes('district'));
    let catIdx = headers.findIndex(h => h.includes('kategori') || h.includes('category'));
    let typeIdx = headers.findIndex(h => h.includes('jenis') || h.includes('sub-category') || h.includes('sub category') || h.includes('pecahan'));
    let repIdx = headers.findIndex(h => h.includes('dilaporkan') || h.includes('reported') || h.includes('kes dilaporkan'));
    let solIdx = headers.findIndex(h => h.includes('penyelesaian') || h.includes('solved') || h.includes('kes penyelesaian') || h.includes('selesai'));
    
    // Fallback defaults
    if (yearIdx === -1) yearIdx = 0;
    if (ipdIdx === -1) ipdIdx = 1;
    if (catIdx === -1) catIdx = 2;
    if (typeIdx === -1) typeIdx = 3;
    if (repIdx === -1) repIdx = 4;
    if (solIdx === -1) solIdx = 5;
    
    const records = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 6) continue;
        
        const year = parseInt(row[yearIdx]) || 2025;
        const ipd = String(row[ipdIdx] || '').trim();
        const category = String(row[catIdx] || '').trim();
        const jenis = String(row[typeIdx] || '').trim();
        const dilaporkan = parseInt(row[repIdx]) || 0;
        const penyelesaian = parseInt(row[solIdx]) || 0;
        
        if (ipd && category && jenis) {
            records.push({
                tahun: year,
                ipd: ipd,
                kategori: category,
                jenis: jenis,
                dilaporkan: dilaporkan,
                penyelesaian: penyelesaian
            });
        }
    }
    return records;
}

// 2. Fetch Data from static files / cache (loads CSV data + GeoJSON in parallel)
function fetchDashboardData() {
    const loader = document.getElementById('loader-overlay');
    if (loader) loader.style.opacity = '1';

    const cachedData = localStorage.getItem('pdrm_cached_data');
    const dataPromise = cachedData 
        ? Promise.resolve(JSON.parse(cachedData))
        : fetch('pdrm_selangor_crime_data_2025.csv')
            .then(r => {
                if (!r.ok) throw new Error('Gagal memuatkan fail data CSV');
                return r.text();
            })
            .then(text => {
                const rows = parseCSV(text);
                const parsed = mapRowsToObjects(rows);
                localStorage.setItem('pdrm_cached_data', JSON.stringify(parsed));
                return parsed;
            });

    Promise.all([
        dataPromise,
        fetch('selangor_districts.geojson').then(r => {
            if (!r.ok) throw new Error('Gagal memuatkan GeoJSON');
            return r.json();
        })
    ])
    .then(([data, geojson]) => {
        rawData = data;
        filteredData = [...data];
        selangorGeoJSON = geojson;

        // Register GeoJSON with ECharts
        echarts.registerMap('Selangor', selangorGeoJSON);

        // Populate IPD Dropdown
        populateIpdSelector();

        // Initial Dashboard Refresh
        refreshDashboard();

        // Hide Loader
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        }
    })
    .catch(error => {
        console.error('Error fetching dashboard data:', error);
        alert('Amaran: Gagal memuatkan data. Sila pastikan fail data dan geojson wujud di pelayan.');
        if (loader) {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        }
    });
}

// 3. Populate District IPD Dropdown
function populateIpdSelector() {
    const selector = document.getElementById('ipd-selector');
    
    // Extract unique IPD names, sort alphabetically
    const ipds = [...new Set(rawData.map(item => item.ipd))].sort();
    
    // Clear and reset (keeping "Semua Daerah")
    selector.innerHTML = '<option value="ALL">Semua Daerah (Selangor)</option>';
    
    ipds.forEach(ipd => {
        const option = document.createElement('option');
        option.value = ipd;
        option.textContent = ipd;
        selector.appendChild(option);
    });
}

// 4. Setup Event Listeners for Filters, Search, and Pagination
// 4. Setup Event Listeners for Filters, Search, and Pagination
function setupEventListeners() {
    // IPD selector change
    document.getElementById('ipd-selector').addEventListener('change', (e) => {
        refreshDashboard();
    });

    // Period selector change
    const periodSel = document.getElementById('period-selector');
    if (periodSel) {
        periodSel.addEventListener('change', () => {
            refreshDashboard();
        });
    }

    // Theme Toggle Button
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const isLight = document.body.classList.toggle('dashboard-theme-light');
            localStorage.setItem('pdrm_theme', isLight ? 'light' : 'dark');
            const themeIcon = themeBtn.querySelector('i');
            if (themeIcon) {
                themeIcon.className = isLight ? 'fas fa-moon' : 'fas fa-sun';
            }
            updateThemeColors();
            refreshDashboard(); // Re-render charts with correct color variables
        });
    }

    // Print Button
    const printBtn = document.getElementById('btn-print');
    if (printBtn) {
        printBtn.addEventListener('click', () => {
            window.print();
        });
    }

    // PDF Download Button
    const pdfBtn = document.getElementById('btn-pdf');
    if (pdfBtn) {
        pdfBtn.addEventListener('click', () => {
            const element = document.querySelector('.dashboard-container');
            const opt = {
                margin:       10,
                filename:     'Laporan_Analisis_Jenayah_Selangor.pdf',
                image:        { type: 'jpeg', quality: 0.98 },
                html2canvas:  { scale: 1.5, useCORS: true, logging: false },
                jsPDF:        { unit: 'mm', format: 'a3', orientation: 'landscape' }
            };
            
            const loader = document.getElementById('loader-overlay');
            if (loader) {
                loader.style.display = 'flex';
                loader.style.opacity = '1';
                loader.querySelector('p').textContent = 'Menjana laporan PDF... Sila tunggu sebentar.';
            }
            
            html2pdf().set(opt).from(element).save().finally(() => {
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => {
                        loader.style.display = 'none';
                        loader.querySelector('p').textContent = 'Memuatkan Data Portal Jenayah Selangor...';
                    }, 500);
                }
            });
        });
    }

    // Table Search box input
    document.getElementById('table-search').addEventListener('input', (e) => {
        tableState.searchQuery = e.target.value.toLowerCase().trim();
        tableState.currentPage = 1;
        updateTable();
    });

    // Table Category filter change
    document.getElementById('category-filter').addEventListener('change', (e) => {
        tableState.categoryFilter = e.target.value;
        tableState.currentPage = 1;
        updateTable();
    });

    // Pagination buttons
    document.getElementById('btn-first-page').addEventListener('click', () => {
        if (tableState.currentPage > 1) {
            tableState.currentPage = 1;
            updateTable();
        }
    });

    document.getElementById('btn-prev-page').addEventListener('click', () => {
        if (tableState.currentPage > 1) {
            tableState.currentPage--;
            updateTable();
        }
    });

    document.getElementById('btn-next-page').addEventListener('click', () => {
        const totalPages = Math.ceil(getFilteredTableData().length / tableState.pageSize);
        if (tableState.currentPage < totalPages) {
            tableState.currentPage++;
            updateTable();
        }
    });

    document.getElementById('btn-last-page').addEventListener('click', () => {
        const totalPages = Math.ceil(getFilteredTableData().length / tableState.pageSize);
        if (tableState.currentPage < totalPages) {
            tableState.currentPage = totalPages;
            updateTable();
        }
    });

    // Table Sorting logic (click on headers)
    const headers = document.querySelectorAll('#crime-table th[data-sort]');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const sortBy = header.getAttribute('data-sort');
            if (tableState.sortBy === sortBy) {
                // toggle order
                tableState.sortOrder = tableState.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                tableState.sortBy = sortBy;
                tableState.sortOrder = 'desc'; // default to desc on new column
            }
            
            // Update UI sort indicators
            headers.forEach(h => {
                const icon = h.querySelector('i');
                if (h.getAttribute('data-sort') === sortBy) {
                    icon.className = tableState.sortOrder === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
                    icon.style.opacity = '1';
                } else {
                    icon.className = 'fas fa-sort';
                    icon.style.opacity = '0.4';
                }
            });

            tableState.currentPage = 1;
            updateTable();
        });
    });

    // Window Resize chart responsiveness
    window.addEventListener('resize', () => {
        Object.values(chartInstances).forEach(chart => {
            if (chart) chart.resize();
        });
    });
}

// ============================================================
// Upload Modal Logic
// ============================================================
let selectedFile = null;

function setupUploadModal() {
    const modal = document.getElementById('upload-modal');
    const openBtn = document.getElementById('btn-upload-csv');
    const closeBtn = document.getElementById('modal-close');
    const cancelBtn = document.getElementById('btn-cancel-upload');
    const browseBtn = document.getElementById('btn-browse');
    const fileInput = document.getElementById('csv-file-input');
    const dropzone = document.getElementById('upload-dropzone');
    const submitBtn = document.getElementById('btn-submit-upload');
    const removeBtn = document.getElementById('btn-remove-file');

    if (!modal || !openBtn) return;

    // Open modal
    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        resetUploadModal();
    });

    // Close modal
    const closeModal = () => { modal.style.display = 'none'; resetUploadModal(); };
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Browse button click
    browseBtn.addEventListener('click', () => fileInput.click());

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelected(e.target.files[0]);
    });

    // Drag and drop
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
            if (ext === '.csv' || ext === '.xls' || ext === '.xlsx') {
                handleFileSelected(file);
            } else {
                showUploadStatus('Sila pilih fail berformat .csv, .xls atau .xlsx sahaja.', 'error');
            }
        }
    });

    // Remove selected file
    removeBtn.addEventListener('click', () => {
        selectedFile = null;
        fileInput.value = '';
        document.getElementById('upload-file-info').style.display = 'none';
        document.getElementById('upload-dropzone').style.display = 'flex';
        submitBtn.disabled = true;
        hideUploadStatus();
    });

    // Submit upload
    submitBtn.addEventListener('click', () => uploadCSV());
}

function setupChangePasswordModal() {
    const modal = document.getElementById('change-pw-modal');
    const openBtn = document.getElementById('btn-open-change-pw');
    const closeBtn = document.getElementById('change-pw-close');
    const cancelBtn = document.getElementById('btn-cancel-change-pw');
    const submitBtn = document.getElementById('btn-submit-change-pw');
    const form = document.getElementById('change-pw-form');
    
    const errorEl = document.getElementById('change-pw-error');
    const errorText = document.getElementById('change-pw-error-text');
    const successEl = document.getElementById('change-pw-success');
    
    if (!modal || !openBtn) return;
    
    const resetModal = () => {
        form.reset();
        errorEl.style.display = 'none';
        successEl.style.display = 'none';
    };
    
    // Open
    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        resetModal();
    });
    
    // Close
    const closeModal = () => {
        modal.style.display = 'none';
        resetModal();
    };
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    
    // Submit
    submitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        
        const currentPw = document.getElementById('change-pw-current').value;
        const newPw = document.getElementById('change-pw-new').value;
        const confirmPw = document.getElementById('change-pw-confirm').value;
        
        errorEl.style.display = 'none';
        successEl.style.display = 'none';
        
        if (!currentPw || !newPw || !confirmPw) {
            errorText.textContent = 'Sila isi semua ruangan.';
            errorEl.style.display = 'block';
            return;
        }
        
        if (newPw !== confirmPw) {
            errorText.textContent = 'Kata laluan baharu dan sahkan kata laluan tidak sepadan.';
            errorEl.style.display = 'block';
            return;
        }
        
        // Load active users
        const activeUsers = JSON.parse(localStorage.getItem('pdrm_users'));
        const currentUsername = sessionStorage.getItem('pdrm_username') || 'admin';
        
        if (activeUsers && activeUsers[currentUsername]) {
            const user = activeUsers[currentUsername];
            if (user.password === currentPw) {
                // Update password
                user.password = newPw;
                activeUsers[currentUsername] = user;
                localStorage.setItem('pdrm_users', JSON.stringify(activeUsers));
                
                // Show success
                successEl.style.display = 'flex';
                form.reset();
                
                // Close after 1.5s
                setTimeout(() => {
                    closeModal();
                }, 1500);
            } else {
                errorText.textContent = 'Kata laluan semasa salah.';
                errorEl.style.display = 'block';
            }
        } else {
            errorText.textContent = 'Akaun tidak ditemui.';
            errorEl.style.display = 'block';
        }
    });
}

// ============================================================
// Add Data Modal (POC Data Management)
// ============================================================
function setupAddDataModal() {
    const modal = document.getElementById('add-data-modal');
    const openBtn = document.getElementById('btn-open-add-data');
    const closeBtn = document.getElementById('add-data-close');
    const cancelBtn = document.getElementById('btn-cancel-add-data');
    const submitBtn = document.getElementById('btn-submit-add-data');
    const form = document.getElementById('add-data-form');
    const errorEl = document.getElementById('add-data-error');
    const errorText = document.getElementById('add-data-error-text');
    const successEl = document.getElementById('add-data-success');

    if (!modal || !openBtn) return;

    const resetModal = () => {
        form.reset();
        errorEl.style.display = 'none';
        successEl.style.display = 'none';
    };

    const closeModal = () => {
        modal.style.display = 'none';
        resetModal();
    };

    openBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        resetModal();
    });

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    submitBtn.addEventListener('click', () => {
        const ipd = document.getElementById('add-data-ipd').value;
        const jenis = document.getElementById('add-data-jenis').value;
        const status = document.getElementById('add-data-status').value;

        errorEl.style.display = 'none';
        successEl.style.display = 'none';

        if (!ipd || !jenis) {
            errorText.textContent = 'Sila pilih IPD dan Jenis Jenayah.';
            errorEl.style.display = 'flex';
            return;
        }

        // Determine category from jenis selection
        const violentTypes = ['Bunuh', 'Rogol', 'Samun', 'Mencederakan'];
        const isViolent = violentTypes.some(t => jenis.includes(t));
        const kategori = isViolent
            ? 'Jenayah Kekerasan (Violent Crime)'
            : 'Jenayah Harta Benda (Property Crime)';

        // Add 1 dilaporkan; if Selesai add 1 penyelesaian too
        const dilaporkan = 1;
        const penyelesaian = status === 'Selesai' ? 1 : 0;

        const newRecord = {
            tahun: new Date().getFullYear(),
            ipd: ipd,
            kategori: kategori,
            jenis: jenis,
            dilaporkan: dilaporkan,
            penyelesaian: penyelesaian
        };

        // Append into rawData
        rawData.push(newRecord);

        // Persist to localStorage cache
        localStorage.setItem('pdrm_cached_data', JSON.stringify(rawData));

        // Reactive re-render all charts and map
        refreshDashboard();

        // Show success banner
        successEl.style.display = 'flex';

        // Auto-close after 1.5s
        setTimeout(() => closeModal(), 1500);
    });
}

// ============================================================
// Export Updated CSV
// ============================================================
function setupExportCSV() {
    const exportBtn = document.getElementById('btn-export-csv');
    if (!exportBtn) return;

    exportBtn.addEventListener('click', () => {
        if (!rawData || rawData.length === 0) {
            alert('Tiada data untuk dieksport.');
            return;
        }

        // Build CSV string with PDRM headers
        const headers = ['Tahun (Year)', 'Daerah Polis (IPD)', 'Kategori Jenayah (Category)', 'Jenis Jenayah (Sub-Category)', 'Kes Dilaporkan (Reported Cases)', 'Kes Penyelesaian (Solved Cases)'];
        const rows = rawData.map(item => [
            item.tahun,
            item.ipd,
            item.kategori,
            `"${item.jenis}"`, // Quote to handle commas in crime names
            item.dilaporkan,
            item.penyelesaian
        ]);

        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

        // Trigger browser download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const today = new Date().toISOString().slice(0, 10);
        link.download = `pdrm_selangor_crime_data_${today}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    });
}

function handleFileSelected(file) {
    selectedFile = file;
    document.getElementById('upload-dropzone').style.display = 'none';
    document.getElementById('upload-file-info').style.display = 'block';
    
    // Set appropriate icon
    const fileIcon = document.getElementById('file-type-icon');
    if (fileIcon) {
        if (file.name.endsWith('.csv')) {
            fileIcon.className = 'fas fa-file-csv file-icon text-cyan';
        } else {
            fileIcon.className = 'fas fa-file-excel file-icon text-green';
        }
    }
    
    document.getElementById('upload-file-name').textContent = file.name;
    document.getElementById('upload-file-size').textContent = formatFileSize(file.size);
    document.getElementById('btn-submit-upload').disabled = false;
    hideUploadStatus();
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function resetUploadModal() {
    selectedFile = null;
    const fileInput = document.getElementById('csv-file-input');
    if (fileInput) fileInput.value = '';
    const dropzone = document.getElementById('upload-dropzone');
    if (dropzone) dropzone.style.display = 'flex';
    const fileInfo = document.getElementById('upload-file-info');
    if (fileInfo) fileInfo.style.display = 'none';
    const submitBtn = document.getElementById('btn-submit-upload');
    if (submitBtn) submitBtn.disabled = true;
    const progress = document.getElementById('upload-progress');
    if (progress) progress.style.display = 'none';
    hideUploadStatus();
}

function showUploadStatus(message, type) {
    const el = document.getElementById('upload-status');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'upload-status ' + (type === 'success' ? 'status-success' : 'status-error');
    el.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-triangle'}"></i> ${message}`;
}

function hideUploadStatus() {
    const el = document.getElementById('upload-status');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
}

function uploadCSV() {
    if (!selectedFile) return;

    const token = sessionStorage.getItem('pdrm_token');
    if (!token) {
        showUploadStatus('Sesi tidak sah. Sila log masuk semula.', 'error');
        return;
    }

    const submitBtn = document.getElementById('btn-submit-upload');
    const progressEl = document.getElementById('upload-progress');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressText = document.getElementById('upload-progress-text');

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses...';
    progressEl.style.display = 'flex';

    // Simulate progress bar movement
    let progress = 0;
    const progressInterval = setInterval(() => {
        if (progress < 90) {
            progress += Math.random() * 20;
            if (progress > 90) progress = 90;
            progressBar.style.width = progress + '%';
            progressText.textContent = Math.floor(progress) + '%';
        }
    }, 100);

    const fileReader = new FileReader();
    const ext = selectedFile.name.substring(selectedFile.name.lastIndexOf('.')).toLowerCase();
    const isExcel = ext === '.xls' || ext === '.xlsx';

    fileReader.onload = function(e) {
        clearInterval(progressInterval);
        try {
            let parsedData = [];
            if (isExcel) {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                parsedData = mapRowsToObjects(rows);
            } else {
                const text = e.target.result;
                const rows = parseCSV(text);
                parsedData = mapRowsToObjects(rows);
            }

            if (parsedData.length === 0) {
                throw new Error('Fail tidak mengandungi data padanan yang sah. Sila semak format kolum.');
            }

            // Save to localStorage
            localStorage.setItem('pdrm_cached_data', JSON.stringify(parsedData));

            progressBar.style.width = '100%';
            progressText.textContent = '100%';

            showUploadStatus(`Berjaya! ${parsedData.length} rekod dari "${selectedFile.name}" telah diproses secara lokal.`, 'success');

            setTimeout(() => {
                rawData = parsedData;
                filteredData = [...parsedData];
                populateIpdSelector();
                refreshDashboard();

                setTimeout(() => {
                    document.getElementById('upload-modal').style.display = 'none';
                    resetUploadModal();
                }, 2000);
            }, 500);

        } catch (err) {
            showUploadStatus(err.message || 'Ralat semasa memproses fail.', 'error');
            progressEl.style.display = 'none';
        }
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-upload"></i> Muat Naik &amp; Proses';
    };

    fileReader.onerror = function() {
        clearInterval(progressInterval);
        showUploadStatus('Ralat semasa membaca fail.', 'error');
        progressEl.style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-upload"></i> Muat Naik &amp; Proses';
    };

    if (isExcel) {
        fileReader.readAsArrayBuffer(selectedFile);
    } else {
        fileReader.readAsText(selectedFile);
    }
}

// ============================================================
// Logout Logic (Client-side simulation)
// ============================================================
function setupLogout() {
    const logoutBtn = document.getElementById('btn-logout');
    if (!logoutBtn) return;

    logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('pdrm_token');
        sessionStorage.removeItem('pdrm_user');
        window.location.href = 'login.html';
    });
}

// 5. Main Refresh function
function refreshDashboard() {
    const selectedIpd = document.getElementById('ipd-selector').value;
    
    // Apply IPD Filter
    if (selectedIpd === 'ALL') {
        filteredData = [...rawData];
    } else {
        filteredData = rawData.filter(item => item.ipd === selectedIpd);
    }
    
    // Reset table pagination
    tableState.currentPage = 1;
    
    // Recalculate KPIs
    calculateKPIs(selectedIpd);
    
    // Update Charts
    renderCategoryChart(selectedIpd);
    renderSubCategoryChart();
    renderIpdComparisonChart(selectedIpd);
    renderTrendChart();
    renderRiskRanking();
    renderSelangorMap();
    
    // Update detailed table
    updateTable();
}

// 6. Calculate KPIs
function calculateKPIs(selectedIpd) {
    let totalReported = 0;
    let totalSolved = 0;
    let violentCount = 0;
    let propertyCount = 0;
    
    filteredData.forEach(item => {
        totalReported += item.dilaporkan;
        totalSolved += item.penyelesaian;
        
        if (item.kategori.includes('Kekerasan')) {
            violentCount += item.dilaporkan;
        } else if (item.kategori.includes('Harta Benda')) {
            propertyCount += item.dilaporkan;
        }
    });
    
    const solveRate = totalReported > 0 ? (totalSolved / totalReported) * 100 : 0;
    
    // Update UI numbers
    animateNumber('val-reported', totalReported);
    animateNumber('val-solved', totalSolved);
    document.getElementById('val-solve-rate').textContent = `${solveRate.toFixed(1)}%`;
    animateNumber('val-violent', violentCount);
    animateNumber('val-property', propertyCount);
    
    // Solved cases details
    document.getElementById('val-solved-percent').innerHTML = `<i class="fas fa-percentage"></i> ${totalReported > 0 ? ((totalSolved / totalReported) * 100).toFixed(0) : 0}% Kes Berjaya Selesai`;
    
    // KPI standard status text
    const statusEl = document.getElementById('val-solve-status');
    if (solveRate >= 65) {
        statusEl.className = 'kpi-trend trend-up';
        statusEl.innerHTML = '<i class="fas fa-shield-alt"></i> PRESTASI CEMERLANG (KPI > 65%)';
    } else if (solveRate >= 45) {
        statusEl.className = 'kpi-trend trend-neutral';
        statusEl.innerHTML = '<i class="fas fa-exclamation-circle"></i> PRESTASI SEDERHANA (KPI 45-65%)';
    } else {
        statusEl.className = 'kpi-trend trend-down';
        statusEl.innerHTML = '<i class="fas fa-times-circle"></i> PRESTASI AMARAN (KPI < 45%)';
    }
}

// Helper to animate numbers incrementing
function animateNumber(elementId, targetValue) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const startValue = parseInt(element.textContent.replace(/,/g, '')) || 0;
    if (startValue === targetValue) {
        element.textContent = targetValue.toLocaleString();
        return;
    }
    
    const duration = 800; // ms
    const startTime = performance.now();
    
    const update = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out quad
        const easeProgress = progress * (2 - progress);
        const currentValue = Math.floor(startValue + (targetValue - startValue) * easeProgress);
        
        element.textContent = currentValue.toLocaleString();
        
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = targetValue.toLocaleString();
        }
    };
    
    requestAnimationFrame(update);
}

// 7. Render Donut Chart (Category: Violent vs Property)
function renderCategoryChart(selectedIpd) {
    const chartDom = document.getElementById('chart-category');
    if (!chartInstances.category) {
        chartInstances.category = echarts.init(chartDom);
    }
    
    let violentCases = 0;
    let propertyCases = 0;
    
    filteredData.forEach(item => {
        if (item.kategori.includes('Kekerasan')) {
            violentCases += item.dilaporkan;
        } else {
            propertyCases += item.dilaporkan;
        }
    });

    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: '{b}: <b>{c} kes</b> ({d}%)',
            backgroundColor: 'rgba(7, 14, 32, 0.95)',
            borderColor: COLORS.cyan,
            textStyle: { color: '#ffffff' }
        },
        legend: {
            bottom: '5%',
            left: 'center',
            textStyle: { color: COLORS.axisText, fontSize: 11 },
            itemWidth: 10,
            itemHeight: 10
        },
        series: [
            {
                name: 'Kategori Jenayah',
                type: 'pie',
                radius: ['45%', '70%'],
                center: ['50%', '42%'],
                avoidLabelOverlap: false,
                itemStyle: {
                    borderRadius: 6,
                    borderColor: '#0b1528',
                    borderWidth: 2
                },
                label: {
                    show: false,
                    position: 'center'
                },
                emphasis: {
                    label: {
                        show: true,
                        fontSize: 14,
                        fontWeight: 'bold',
                        color: '#ffffff',
                        formatter: '{b}\n{d}%'
                    }
                },
                labelLine: {
                    show: false
                },
                data: [
                    { 
                        value: violentCases, 
                        name: 'Jenayah Kekerasan',
                        itemStyle: {
                            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                                { offset: 0, color: COLORS.red },
                                { offset: 1, color: '#991b1b' }
                            ])
                        }
                    },
                    { 
                        value: propertyCases, 
                        name: 'Jenayah Harta Benda',
                        itemStyle: {
                            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                                { offset: 0, color: COLORS.orange },
                                { offset: 1, color: '#c2410c' }
                            ])
                        }
                    }
                ]
            }
        ]
    };

    chartInstances.category.setOption(option);
}

// 8. Render Horizontal Bar Chart (Top Sub-Categories)
function renderSubCategoryChart() {
    const chartDom = document.getElementById('chart-sub-category');
    if (!chartInstances.subCategory) {
        chartInstances.subCategory = echarts.init(chartDom);
    }
    
    // Aggregate by sub-category
    const subAgg = {};
    filteredData.forEach(item => {
        const sub = item.jenis;
        if (!subAgg[sub]) subAgg[sub] = 0;
        subAgg[sub] += item.dilaporkan;
    });
    
    // Convert to sorted array
    const sortedSubs = Object.keys(subAgg).map(key => ({
        name: key,
        value: subAgg[key]
    })).sort((a, b) => a.value - b.value); // ascending for horizontal bar chart (rendered bottom-to-top)

    const categories = sortedSubs.map(item => item.name);
    const dataValues = sortedSubs.map(item => item.value);

    const option = {
        backgroundColor: 'transparent',
        grid: {
            top: '8%',
            left: '3%',
            right: '8%',
            bottom: '3%',
            containLabel: true
        },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            backgroundColor: 'rgba(7, 14, 32, 0.95)',
            borderColor: COLORS.cyan,
            textStyle: { color: '#ffffff' }
        },
        xAxis: {
            type: 'value',
            splitLine: { lineStyle: { color: COLORS.gridLine } },
            axisLabel: { color: COLORS.axisText, fontSize: 10 }
        },
        yAxis: {
            type: 'category',
            data: categories,
            axisLabel: { color: COLORS.axisText, fontSize: 9, width: 100, overflow: 'break' },
            axisTick: { show: false },
            axisLine: { lineStyle: { color: COLORS.gridLine } }
        },
        series: [
            {
                name: 'Kes Dilaporkan',
                type: 'bar',
                data: dataValues,
                barWidth: 10,
                itemStyle: {
                    borderRadius: [0, 5, 5, 0],
                    color: new echarts.graphic.LinearGradient(1, 0, 0, 0, [
                        { offset: 0, color: COLORS.cyan },
                        { offset: 1, color: COLORS.purple }
                    ]),
                    shadowBlur: 5,
                    shadowColor: 'rgba(0, 240, 255, 0.3)'
                }
            }
        ]
    };

    chartInstances.subCategory.setOption(option);
}

// 9. Render Large IPD Comparison (Reported vs Solved)
function renderIpdComparisonChart(selectedIpd) {
    const chartDom = document.getElementById('chart-ipd');
    if (!chartInstances.ipd) {
        chartInstances.ipd = echarts.init(chartDom);
    }
    
    // Group rawData by IPD (we show all IPDs for comparison, but can highlight if selected)
    const ipdAgg = {};
    rawData.forEach(item => {
        const name = item.ipd.replace('IPD ', ''); // short name
        if (!ipdAgg[name]) {
            ipdAgg[name] = { reported: 0, solved: 0 };
        }
        ipdAgg[name].reported += item.dilaporkan;
        ipdAgg[name].solved += item.penyelesaian;
    });
    
    // Convert to array and sort descending by reported cases
    const sortedIpds = Object.keys(ipdAgg).map(key => ({
        name: key,
        reported: ipdAgg[key].reported,
        solved: ipdAgg[key].solved
    })).sort((a, b) => b.reported - a.reported);

    const ipdNames = sortedIpds.map(item => item.name);
    const reportedData = sortedIpds.map(item => item.reported);
    const solvedData = sortedIpds.map(item => item.solved);

    // Apply conditional highlighting styling if an IPD is selected
    const shortSelectedIpd = selectedIpd !== 'ALL' ? selectedIpd.replace('IPD ', '') : null;
    
    const option = {
        backgroundColor: 'transparent',
        grid: {
            top: '12%',
            left: '2%',
            right: '2%',
            bottom: '5%',
            containLabel: true
        },
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            backgroundColor: 'rgba(7, 14, 32, 0.95)',
            borderColor: COLORS.cyan,
            textStyle: { color: '#ffffff' },
            formatter: function (params) {
                const name = params[0].name;
                const rep = params[0].value;
                const sol = params[1].value;
                const rate = rep > 0 ? ((sol / rep) * 100).toFixed(1) : 0;
                return `IPD ${name}<br/>
                        <span style="display:inline-block;margin-right:5px;border-radius:10px;width:9px;height:9px;background-color:${COLORS.cyan}"></span>Dilaporkan: <b>${rep}</b><br/>
                        <span style="display:inline-block;margin-right:5px;border-radius:10px;width:9px;height:9px;background-color:${COLORS.green}"></span>Selesai: <b>${sol}</b><br/>
                        Kadar Selesai: <b style="color:${COLORS.yellow}">${rate}%</b>`;
            }
        },
        xAxis: {
            type: 'category',
            data: ipdNames,
            axisLabel: { 
                color: COLORS.axisText, 
                fontSize: 10,
                rotate: 28,
                interval: 0
            },
            axisTick: { show: false },
            axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
        },
        yAxis: {
            type: 'value',
            splitLine: { lineStyle: { color: COLORS.gridLine } },
            axisLabel: { color: COLORS.axisText, fontSize: 10 }
        },
        series: [
            {
                name: 'Dilaporkan',
                type: 'bar',
                data: reportedData,
                barGap: '15%',
                barWidth: 12,
                itemStyle: {
                    borderRadius: [4, 4, 0, 0],
                    color: function (params) {
                        if (shortSelectedIpd && params.name === shortSelectedIpd) {
                            return COLORS.cyan; // highlighted color
                        }
                        return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(0, 240, 255, 0.95)' },
                            { offset: 1, color: 'rgba(0, 240, 255, 0.3)' }
                        ]);
                    },
                    shadowBlur: function (params) {
                        return (shortSelectedIpd && params.name === shortSelectedIpd) ? 10 : 0;
                    },
                    shadowColor: COLORS.cyan
                }
            },
            {
                name: 'Diselesaikan',
                type: 'bar',
                data: solvedData,
                barWidth: 12,
                itemStyle: {
                    borderRadius: [4, 4, 0, 0],
                    color: function (params) {
                        if (shortSelectedIpd && params.name === shortSelectedIpd) {
                            return COLORS.green; // highlighted color
                        }
                        return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(57, 255, 20, 0.95)' },
                            { offset: 1, color: 'rgba(57, 255, 20, 0.3)' }
                        ]);
                    },
                    shadowBlur: function (params) {
                        return (shortSelectedIpd && params.name === shortSelectedIpd) ? 10 : 0;
                    },
                    shadowColor: COLORS.green
                }
            }
        ]
    };

    chartInstances.ipd.setOption(option);
}

// 10. Render Radar Chart (Solve Rates by Sub-Category)
// 10. Render Timeline Trend Chart (Dilaporkan vs Diselesaikan by Day, Week, Month, Year)
function renderTrendChart() {
    const chartDom = document.getElementById('chart-trend');
    if (!chartDom) return;
    
    if (!chartInstances.trend) {
        chartInstances.trend = echarts.init(chartDom);
    }
    
    const period = document.getElementById('period-selector').value;
    
    // Calculate total reported and solved for the filteredData
    let totalRep = 0;
    let totalSol = 0;
    filteredData.forEach(item => {
        totalRep += item.dilaporkan;
        totalSol += item.penyelesaian;
    });
    
    let xAxisData = [];
    let reportedData = [];
    let solvedData = [];
    
    if (period === 'year') {
        // Multi-year comparison
        xAxisData = ['2023', '2024', '2025'];
        reportedData = [Math.round(totalRep * 0.88), Math.round(totalRep * 0.94), totalRep];
        solvedData = [Math.round(totalSol * 0.85), Math.round(totalSol * 0.90), totalSol];
    } else if (period === 'month') {
        // Monthly distribution (Jan - Dec)
        xAxisData = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'];
        const distribution = [0.07, 0.08, 0.09, 0.08, 0.07, 0.09, 0.10, 0.09, 0.08, 0.09, 0.08, 0.08];
        reportedData = distribution.map(d => Math.round(totalRep * d));
        solvedData = distribution.map(d => Math.round(totalSol * d));
    } else if (period === 'week') {
        // Weekly distribution (W1 - W52)
        for (let i = 1; i <= 52; i++) {
            xAxisData.push(`M${i}`);
            // Smooth wavy curve using Math.sin for deterministic visual trend
            const factor = 0.015 + 0.005 * Math.sin(i / 3) + 0.003 * Math.cos(i / 5);
            reportedData.push(Math.round(totalRep * factor));
            solvedData.push(Math.round(totalSol * factor));
        }
    } else if (period === 'day') {
        // Daily distribution (Day 1 - Day 30)
        for (let i = 1; i <= 30; i++) {
            xAxisData.push(`H${i}`);
            const factor = 0.028 + 0.01 * Math.sin(i / 2) + 0.005 * Math.cos(i / 3);
            reportedData.push(Math.round(totalRep * factor));
            solvedData.push(Math.round(totalSol * factor));
        }
    }
    
    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(7, 14, 32, 0.95)',
            borderColor: COLORS.cyan,
            textStyle: { color: '#ffffff' }
        },
        legend: {
            data: ['Dilaporkan', 'Selesai'],
            textStyle: { color: COLORS.axisText, fontSize: 10 },
            bottom: '0%'
        },
        grid: {
            top: '10%',
            left: '3%',
            right: '4%',
            bottom: '15%',
            containLabel: true
        },
        xAxis: {
            type: 'category',
            boundaryGap: false,
            data: xAxisData,
            axisLabel: { color: COLORS.axisText, fontSize: 8 },
            axisLine: { lineStyle: { color: COLORS.gridLine } }
        },
        yAxis: {
            type: 'value',
            splitLine: { lineStyle: { color: COLORS.gridLine } },
            axisLabel: { color: COLORS.axisText, fontSize: 9 }
        },
        series: [
            {
                name: 'Dilaporkan',
                type: 'line',
                data: reportedData,
                smooth: true,
                symbol: 'none',
                lineStyle: { width: 2, color: COLORS.cyan },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(0, 240, 255, 0.2)' },
                        { offset: 1, color: 'rgba(0, 240, 255, 0.0)' }
                    ])
                }
            },
            {
                name: 'Selesai',
                type: 'line',
                data: solvedData,
                smooth: true,
                symbol: 'none',
                lineStyle: { width: 2, color: COLORS.green },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(57, 255, 20, 0.2)' },
                        { offset: 1, color: 'rgba(57, 255, 20, 0.0)' }
                    ])
                }
            }
        ]
    };
    
    chartInstances.trend.setOption(option);
}

// 11. Render Risk Ranking (Top 5 IPDs by Crime Volume)
function renderRiskRanking() {
    const listEl = document.getElementById('risk-ipd-list');
    
    // Group filteredData by IPD
    const ipdAgg = {};
    filteredData.forEach(item => {
        if (!ipdAgg[item.ipd]) {
            ipdAgg[item.ipd] = { reported: 0, solved: 0 };
        }
        ipdAgg[item.ipd].reported += item.dilaporkan;
        ipdAgg[item.ipd].solved += item.penyelesaian;
    });

    const ranked = Object.keys(ipdAgg).map(key => {
        const rep = ipdAgg[key].reported;
        const sol = ipdAgg[key].solved;
        return {
            name: key,
            reported: rep,
            solveRate: rep > 0 ? (sol / rep) * 100 : 0
        };
    }).sort((a, b) => b.reported - a.reported).slice(0, 5); // top 5

    listEl.innerHTML = '';
    
    if (ranked.length === 0) {
        listEl.innerHTML = '<div style="color: var(--color-text-muted); text-align:center; padding-top: 50px;">Tiada data bagi daerah dipilih</div>';
        return;
    }

    ranked.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'ranking-item';
        
        row.innerHTML = `
            <div class="ranking-left">
                <span class="rank-badge">${index + 1}</span>
                <span class="rank-name">${item.name}</span>
            </div>
            <div class="ranking-right">
                <span class="rank-cases">${item.reported} <span style="font-size:0.7rem; font-weight:normal; color:var(--color-text-secondary)">kes</span></span>
                <span class="rank-rate">Selesai: ${item.solveRate.toFixed(0)}%</span>
            </div>
        `;
        
        listEl.appendChild(row);
    });
}

// 12. Detailed Table Operations (Filtering, Searching, Sorting, Pagination)
function getFilteredTableData() {
    return filteredData.filter(item => {
        // Search Filter
        const queryMatch = item.ipd.toLowerCase().includes(tableState.searchQuery) ||
                           item.jenis.toLowerCase().includes(tableState.searchQuery) ||
                           item.kategori.toLowerCase().includes(tableState.searchQuery);
        
        // Category Filter
        const categoryMatch = tableState.categoryFilter === 'ALL' || item.kategori === tableState.categoryFilter;
        
        return queryMatch && categoryMatch;
    });
}

function updateTable() {
    const tableBody = document.getElementById('table-body');
    const tableData = getFilteredTableData();
    
    // Sort
    tableData.sort((a, b) => {
        let valA, valB;
        
        if (tableState.sortBy === 'solve_rate') {
            valA = a.dilaporkan > 0 ? (a.penyelesaian / a.dilaporkan) : 0;
            valB = b.dilaporkan > 0 ? (b.penyelesaian / b.dilaporkan) : 0;
        } else if (tableState.sortBy === 'reported') {
            valA = a.dilaporkan;
            valB = b.dilaporkan;
        } else if (tableState.sortBy === 'solved') {
            valA = a.penyelesaian;
            valB = b.penyelesaian;
        } else if (tableState.sortBy === 'ipd') {
            valA = a.ipd;
            valB = b.ipd;
        } else if (tableState.sortBy === 'category') {
            valA = a.kategori;
            valB = b.kategori;
        } else if (tableState.sortBy === 'sub_category') {
            valA = a.jenis;
            valB = b.jenis;
        }
        
        if (valA < valB) return tableState.sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return tableState.sortOrder === 'asc' ? 1 : -1;
        return 0;
    });
    
    // Table record count text
    document.getElementById('table-row-count').textContent = `Menunjukkan ${tableData.length} rekod`;
    
    // Pagination
    const totalRecords = tableData.length;
    const totalPages = Math.ceil(totalRecords / tableState.pageSize) || 1;
    
    // Boundaries checks
    if (tableState.currentPage > totalPages) tableState.currentPage = totalPages;
    if (tableState.currentPage < 1) tableState.currentPage = 1;
    
    const startIndex = (tableState.currentPage - 1) * tableState.pageSize;
    const endIndex = Math.min(startIndex + tableState.pageSize, totalRecords);
    const paginatedData = tableData.slice(startIndex, endIndex);
    
    // Render Rows
    tableBody.innerHTML = '';
    
    if (paginatedData.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; color: var(--color-text-muted); padding: 40px 0;">
                    <i class="fas fa-search" style="font-size: 1.5rem; margin-bottom: 10px; display: block;"></i>
                    Tiada rekod padanan ditemui
                </td>
            </tr>
        `;
        // Disable pagination buttons
        updatePaginationButtons(1, 1);
        document.getElementById('pagination-info').textContent = 'Tiada rekod untuk dipaparkan';
        return;
    }
    
    paginatedData.forEach(item => {
        const solveRate = item.dilaporkan > 0 ? (item.penyelesaian / item.dilaporkan) * 100 : 0;
        
        let fillClass = 'bg-low-solve';
        if (solveRate >= 65) fillClass = 'bg-high-solve';
        else if (solveRate >= 40) fillClass = 'bg-med-solve';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-weight: 600;">${item.ipd}</td>
            <td style="font-size: 0.78rem; color: var(--color-text-secondary);">${item.kategori.split('(')[0].trim()}</td>
            <td>${item.jenis}</td>
            <td class="text-right table-num text-cyan" style="font-weight:600;">${item.dilaporkan.toLocaleString()}</td>
            <td class="text-right table-num text-green">${item.penyelesaian.toLocaleString()}</td>
            <td>
                <div class="progress-cell">
                    <div class="progress-track">
                        <div class="progress-fill ${fillClass}" style="width: ${solveRate}%"></div>
                    </div>
                    <span class="progress-rate-num ${solveRate >= 65 ? 'text-green' : (solveRate >= 40 ? 'text-yellow' : 'text-red')}">${solveRate.toFixed(0)}%</span>
                </div>
            </td>
            <td class="text-center" style="position: relative; z-index: 20;">
                <button class="btn-delete-row" style="background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); padding: 5px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s;" title="Padam Rekod">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        `;
        
        // Handle delete action
        const deleteBtn = row.querySelector('.btn-delete-row');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Stop row selection filter
            if (confirm(`Adakah anda pasti mahu memadam rekod ini untuk ${item.ipd} (${item.jenis})?`)) {
                const idx = rawData.indexOf(item);
                if (idx > -1) {
                    rawData.splice(idx, 1);
                    localStorage.setItem('pdrm_cached_data', JSON.stringify(rawData));
                    refreshDashboard();
                }
            }
        });
        
        // Click on row to select and filter by this IPD
        row.addEventListener('click', () => {
            const selector = document.getElementById('ipd-selector');
            if (selector.value !== item.ipd) {
                selector.value = item.ipd;
                refreshDashboard();
            }
        });
        
        tableBody.appendChild(row);
    });
    
    // Update pagination labels
    document.getElementById('pagination-info').textContent = `Menunjukkan ${startIndex + 1}-${endIndex} dari ${totalRecords} rekod`;
    document.getElementById('current-page-num').textContent = tableState.currentPage;
    
    updatePaginationButtons(tableState.currentPage, totalPages);
}

function updatePaginationButtons(current, total) {
    document.getElementById('btn-first-page').disabled = (current === 1);
    document.getElementById('btn-prev-page').disabled = (current === 1);
    document.getElementById('btn-next-page').disabled = (current === total);
    document.getElementById('btn-last-page').disabled = (current === total);
}

// ============================================================
// 12. Render Selangor Choropleth District Map
// ============================================================
function renderSelangorMap() {
    if (!selangorGeoJSON) return;

    const chartDom = document.getElementById('chart-map');
    if (!chartDom) return;

    if (!chartInstances.map) {
        chartInstances.map = echarts.init(chartDom);
    }

    // Aggregate crime data per administrative district using DISTRICT_IPD_MAP
    const districtData = {};
    const districtSolved = {};

    Object.entries(DISTRICT_IPD_MAP).forEach(([district, ipds]) => {
        let totalRep = 0;
        let totalSol = 0;
        rawData.forEach(item => {
            if (ipds.includes(item.ipd)) {
                totalRep += item.dilaporkan;
                totalSol += item.penyelesaian;
            }
        });
        districtData[district] = totalRep;
        districtSolved[district] = totalSol;
    });

    // Build ECharts map data array
    const mapData = Object.entries(districtData).map(([name, value]) => ({ name, value }));

    const maxValue = Math.max(...Object.values(districtData));
    const minValue = Math.min(...Object.values(districtData));

    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            showDelay: 0,
            transitionDuration: 0.2,
            backgroundColor: 'rgba(5, 15, 40, 0.92)',
            borderColor: COLORS.cyan,
            textStyle: { color: '#ffffff', fontSize: 12 },
            formatter: function(params) {
                if (!params.data) return params.name + '<br/>Tiada data';
                const name = params.name;
                const rep = params.data.value || 0;
                const sol = districtSolved[name] || 0;
                const rate = rep > 0 ? ((sol / rep) * 100).toFixed(1) : 0;
                const ipds = DISTRICT_IPD_MAP[name] || [];
                return `<div style="font-family:'Orbitron',monospace;font-size:13px;color:${COLORS.cyan};margin-bottom:6px;">
                    📌 ${name}
                </div>
                <div style="display:flex;gap:20px;">
                    <div>
                        <div style="color:#9ca3af;font-size:11px;">Kes Dilaporkan</div>
                        <div style="color:${COLORS.cyan};font-weight:bold;font-size:14px;">${rep.toLocaleString()}</div>
                    </div>
                    <div>
                        <div style="color:#9ca3af;font-size:11px;">Kes Selesai</div>
                        <div style="color:${COLORS.green};font-weight:bold;font-size:14px;">${sol.toLocaleString()}</div>
                    </div>
                    <div>
                        <div style="color:#9ca3af;font-size:11px;">Kadar Selesai</div>
                        <div style="color:${COLORS.yellow};font-weight:bold;font-size:14px;">${rate}%</div>
                    </div>
                </div>
                <div style="margin-top:6px;color:#6b7280;font-size:10px;">IPD: ${ipds.map(i => i.replace('IPD ','')).join(', ')}</div>`;
            }
        },
        visualMap: {
            min: minValue,
            max: maxValue,
            left: 'left',
            bottom: '15%',
            text: ['Tinggi', 'Rendah'],
            textStyle: {
                color: COLORS.axisText,
                fontSize: 10,
                fontFamily: 'Orbitron, monospace'
            },
            realtime: false,
            calculable: false,
            inRange: {
                color: [
                    '#050f28',
                    '#0a2060',
                    '#0050a0',
                    '#0090c0',
                    '#00c8c8',
                    '#f59e0b',
                    '#ef4444',
                    '#ff0000'
                ]
            },
            outOfRange: {
                color: ['rgba(11, 23, 49, 0.5)']
            },
            show: false  // We use our custom legend bar in HTML
        },
        series: [
            {
                name: 'Selangor Crime Map',
                type: 'map',
                map: 'Selangor',
                roam: true,
                zoom: 1.1,
                scaleLimit: { min: 0.8, max: 5 },
                data: mapData,
                nameProperty: 'name',
                label: {
                    show: true,
                    color: '#e2e8f0',
                    fontSize: 11,
                    fontWeight: 'bold',
                    fontFamily: 'Inter, sans-serif',
                    textShadowColor: 'rgba(0,0,0,0.8)',
                    textShadowBlur: 4
                },
                emphasis: {
                    label: {
                        show: true,
                        color: '#ffffff',
                        fontSize: 13,
                        fontWeight: 'bold'
                    },
                    itemStyle: {
                        areaColor: COLORS.cyan,
                        shadowBlur: 20,
                        shadowColor: COLORS.cyan
                    }
                },
                select: {
                    label: { show: true, color: '#000', fontWeight: 'bold' },
                    itemStyle: { areaColor: COLORS.yellow }
                },
                itemStyle: {
                    areaColor: '#050f28',
                    borderColor: 'rgba(0, 240, 255, 0.4)',
                    borderWidth: 1.5,
                    shadowColor: 'rgba(0, 240, 255, 0.1)',
                    shadowBlur: 8
                }
            }
        ]
    };

    chartInstances.map.setOption(option);

    // On click: filter the entire dashboard by district's IPDs
    chartInstances.map.off('click'); // remove old handler if re-rendering
    chartInstances.map.on('click', function(params) {
        if (!params.name) return;
        const district = params.name;
        const ipds = DISTRICT_IPD_MAP[district];
        if (!ipds || ipds.length === 0) return;

        // Show the tooltip overlay panel
        const tooltipEl = document.getElementById('map-tooltip');
        const rep = districtData[district] || 0;
        const sol = districtSolved[district] || 0;
        const rate = rep > 0 ? ((sol / rep) * 100).toFixed(1) : 0;

        document.getElementById('map-tooltip-district').textContent = district;
        document.getElementById('map-tooltip-reported').textContent = rep.toLocaleString();
        document.getElementById('map-tooltip-solved').textContent = sol.toLocaleString();
        document.getElementById('map-tooltip-rate').textContent = `${rate}%`;
        document.getElementById('map-tooltip-ipds').textContent = ipds.map(i => i.replace('IPD ', '')).join(', ');

        if (tooltipEl) {
            tooltipEl.style.display = 'block';
        }

        // If the district has only one IPD, filter by that IPD
        // Otherwise reset to ALL (to show overview of multiple IPDs)
        const selector = document.getElementById('ipd-selector');
        if (ipds.length === 1) {
            selector.value = ipds[0];
        } else {
            selector.value = 'ALL';
        }
        refreshDashboard();
    });
}
