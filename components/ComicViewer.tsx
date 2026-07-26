import React, { useState } from 'react';
import { X, ChevronLeft, ChevronRight, Download, FileText } from 'lucide-react';
import { API_BASE_URL } from '../constants';

interface ComicPage {
    scene_id: number;
    url: string;
}

interface ComicViewerProps {
    pages: ComicPage[];
    pdfUrl: string | null;
    onClose: () => void;
}

export const ComicViewer: React.FC<ComicViewerProps> = ({ pages, pdfUrl, onClose }) => {
    const [currentIndex, setCurrentIndex] = useState(0);

    if (!pages || pages.length === 0) return null;

    const handlePrev = () => {
        setCurrentIndex((prev) => (prev > 0 ? prev - 1 : prev));
    };

    const handleNext = () => {
        setCurrentIndex((prev) => (prev < pages.length - 1 ? prev + 1 : prev));
    };

    const currentUrl = pages[currentIndex].url.startsWith('http') 
        ? pages[currentIndex].url 
        : `${API_BASE_URL.replace('/api', '')}${pages[currentIndex].url}`;
    
    const downloadPdf = () => {
        if (!pdfUrl) return;
        const fullPdfUrl = pdfUrl.startsWith('http') 
            ? pdfUrl 
            : `${API_BASE_URL.replace('/api', '')}${pdfUrl}`;
        window.open(fullPdfUrl, '_blank');
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm">
            
            {/* Main Content */}
            <div className="relative w-full h-full flex flex-col items-center justify-center p-4 pointer-events-none">
                
                {/* Header / Info */}
                <div className="absolute top-4 left-4 flex gap-4 pointer-events-auto">
                    <div className="bg-slate-800/80 px-4 py-2 rounded-full text-white font-medium backdrop-blur">
                        Page {currentIndex + 1} / {pages.length}
                    </div>
                    
                    {pdfUrl && (
                        <button 
                            onClick={downloadPdf}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-full font-medium flex items-center gap-2 transition-colors shadow-lg"
                        >
                            <Download size={18} />
                            Download PDF
                        </button>
                    )}
                </div>

                {/* Image Viewer */}
                <div className="relative flex-1 w-full flex items-center justify-center max-h-[85vh] pointer-events-auto">
                    <img 
                        src={currentUrl} 
                        alt={`Page ${currentIndex + 1}`} 
                        className="max-h-full max-w-full object-contain rounded shadow-2xl border border-slate-800"
                    />
                    
                    {/* Navigation Buttons */}
                    <button 
                        onClick={handlePrev}
                        disabled={currentIndex === 0}
                        className="absolute left-4 lg:left-10 p-3 rounded-full bg-slate-800/50 hover:bg-indigo-600 text-white disabled:opacity-30 disabled:hover:bg-slate-800/50 transition-all"
                    >
                        <ChevronLeft size={32} />
                    </button>
                    
                    <button 
                        onClick={handleNext}
                        disabled={currentIndex === pages.length - 1}
                        className="absolute right-4 lg:right-10 p-3 rounded-full bg-slate-800/50 hover:bg-indigo-600 text-white disabled:opacity-30 disabled:hover:bg-slate-800/50 transition-all"
                    >
                        <ChevronRight size={32} />
                    </button>
                </div>
                
                {/* Thumbnails */}
                <div className="h-20 w-full mt-4 flex gap-2 overflow-x-auto justify-center p-2 pointer-events-auto">
                    {pages.map((page, idx) => (
                        <button
                            key={idx}
                            onClick={() => setCurrentIndex(idx)}
                            className={`flex-shrink-0 h-full aspect-[2/3] rounded overflow-hidden border-2 transition-all ${
                                idx === currentIndex ? 'border-indigo-500 opacity-100' : 'border-transparent opacity-50 hover:opacity-80'
                            }`}
                        >
                             <img 
                                src={page.url.startsWith('http') ? page.url : `${API_BASE_URL.replace('/api', '')}${page.url}`} 
                                className="w-full h-full object-cover" 
                            />
                        </button>
                    ))}
                </div>

            </div>

            {/* Close Button - Moved to end and added z-index */}
            <button 
                onClick={onClose}
                className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-full transition-colors z-50 cursor-pointer"
            >
                <X size={32} />
            </button>
        </div>
    );
};
