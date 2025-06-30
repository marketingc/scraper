// SEO Crawler Frontend JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Initialize tooltips
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    // Auto-focus on URL input if it exists
    const urlInput = document.getElementById('urlInput');
    if (urlInput) {
        urlInput.focus();
    }

    // Add loading states to buttons (excluding search forms)
    const buttons = document.querySelectorAll('.btn[type="submit"]');
    buttons.forEach(button => {
        button.addEventListener('click', function() {
            // Skip loading state for search forms and GET forms
            if (this.form && (this.form.action.includes('/browse') || this.form.method.toLowerCase() === 'get')) {
                return; // Let the form submit normally without loading state
            }
            
            if (this.form && this.form.checkValidity()) {
                this.disabled = true;
                const originalText = this.innerHTML;
                this.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Loading...';
                
                // Re-enable after 30 seconds as fallback
                setTimeout(() => {
                    this.disabled = false;
                    this.innerHTML = originalText;
                }, 30000);
            }
        });
    });

    // Enhanced URL validation
    if (urlInput) {
        urlInput.addEventListener('input', function() {
            const url = this.value;
            const isValid = isValidURL(url);
            
            if (url && !isValid) {
                this.setCustomValidity('Please enter a valid URL (must start with http:// or https://)');
            } else {
                this.setCustomValidity('');
            }
        });
    }

    // Copy to clipboard functionality
    window.copyToClipboard = function(text) {
        navigator.clipboard.writeText(text).then(function() {
            showToast('Copied to clipboard!', 'success');
        }).catch(function() {
            showToast('Failed to copy to clipboard', 'error');
        });
    };

    // Show toast notifications
    window.showToast = function(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `alert alert-${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'info'} position-fixed`;
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
        toast.innerHTML = `
            <div class="d-flex align-items-center">
                <span>${message}</span>
                <button type="button" class="btn-close ms-auto" onclick="this.parentElement.parentElement.remove()"></button>
            </div>
        `;
        document.body.appendChild(toast);
        
        // Auto-remove after 3 seconds
        setTimeout(() => {
            if (toast.parentElement) {
                toast.remove();
            }
        }, 3000);
    };

    // Progressive enhancement for search
    const searchForm = document.querySelector('form[action="/browse"]');
    if (searchForm) {
        searchForm.addEventListener('submit', function(e) {
            const searchInput = this.querySelector('input[name="search"]');
            if (searchInput && searchInput.value.trim() === '') {
                e.preventDefault();
                window.location.href = '/browse';
            }
        });
    }

    // Add keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        // Ctrl/Cmd + K to focus search
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            const searchInput = document.querySelector('input[name="search"]') || document.getElementById('urlInput');
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
        }
        
        // Escape to clear search
        if (e.key === 'Escape') {
            const searchInput = document.querySelector('input[name="search"]');
            if (searchInput && searchInput === document.activeElement) {
                searchInput.value = '';
                window.location.href = '/browse';
            }
        }
    });

    // Add smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // Add animation for cards on scroll
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.animation = 'fadeIn 0.6s ease-out forwards';
            }
        });
    }, observerOptions);

    document.querySelectorAll('.card').forEach(card => {
        observer.observe(card);
    });
});

// Utility functions
function isValidURL(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// Export report functionality
window.exportReport = function(format = 'json') {
    const reportData = window.reportData;
    if (!reportData) {
        showToast('No report data available', 'error');
        return;
    }

    let content, filename, mimeType;
    
    if (format === 'json') {
        content = JSON.stringify(reportData, null, 2);
        filename = `seo-report-${Date.now()}.json`;
        mimeType = 'application/json';
    } else if (format === 'csv') {
        content = convertToCSV(reportData);
        filename = `seo-report-${Date.now()}.csv`;
        mimeType = 'text/csv';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    showToast(`Report exported as ${format.toUpperCase()}`, 'success');
};

function convertToCSV(reportData) {
    const rows = [
        ['URL', reportData.summary.url],
        ['SEO Score', reportData.summary.seoScore],
        ['Title', reportData.details.meta.title || ''],
        ['Description', reportData.details.meta.description || ''],
        ['Word Count', reportData.details.content.wordCount],
        ['Internal Links', reportData.details.links.internal.length],
        ['External Links', reportData.details.links.external.length],
        ['Images Total', reportData.details.images.length],
        ['Images Missing Alt', reportData.details.images.filter(img => img.isEmpty).length]
    ];
    
    return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
}