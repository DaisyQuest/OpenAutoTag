package buildeverything.servlet;

import java.awt.image.BufferedImage;
import java.lang.ref.SoftReference;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Small access-ordered page-image cache. The UI keeps only the visible page and
 * adjacent pages strongly addressable while SoftReference allows GC pressure to
 * reclaim image memory.
 */
public final class SoftPageImageCache {
    private final int maxPages;
    private final Map<Integer, SoftReference<BufferedImage>> pages;

    public SoftPageImageCache(int maxPages) {
        if (maxPages < 1) {
            throw new IllegalArgumentException("maxPages must be positive");
        }
        this.maxPages = maxPages;
        this.pages = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, SoftReference<BufferedImage>> eldest) {
                return size() > SoftPageImageCache.this.maxPages;
            }
        });
    }

    public void put(int pageNumber, BufferedImage image) {
        if (pageNumber < 1) {
            throw new IllegalArgumentException("pageNumber must be >= 1");
        }
        pages.put(pageNumber, new SoftReference<>(image));
    }

    public BufferedImage get(int pageNumber) {
        SoftReference<BufferedImage> reference = pages.get(pageNumber);
        if (reference == null) {
            return null;
        }
        BufferedImage image = reference.get();
        if (image == null) {
            pages.remove(pageNumber);
        }
        return image;
    }

    public void retainAround(int currentPage) {
        pages.keySet().removeIf((page) -> Math.abs(page - currentPage) > 1);
    }

    public int size() {
        pages.values().removeIf((reference) -> reference.get() == null);
        return pages.size();
    }

    public Set<Integer> cachedPages() {
        pages.values().removeIf((reference) -> reference.get() == null);
        return new TreeSet<>(pages.keySet());
    }
}
