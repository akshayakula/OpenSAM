import { NextRequest, NextResponse } from 'next/server';
import { SAMOpportunity, SAMSearchFilters, SAMSearchResponse, EmbeddingRequest, EmbeddingResponse } from '@/types';
import { cosineSimilarity } from '@/lib/utils';
import { vectorStoreUtils } from '@/lib/vectorStore';
import { withCache, generateCacheKey } from '@/lib/redis';

// SAM.gov API configuration
const SAM_BASE_URL = process.env.SAM_BASE_URL || 'https://api.sam.gov';
const SAM_OPPORTUNITIES_ENDPOINT = '/opportunities/v2/search';

// Rate limiting for SAM.gov API
const SAM_RATE_LIMIT_WINDOW = 60000; // 1 minute
const SAM_RATE_LIMIT_MAX_REQUESTS = 100;
const samRateLimitMap = new Map<string, { count: number; timestamp: number }>();

// Cache for embeddings and search results
const embeddingCache = new Map<string, number[]>();
const searchResultsCache = new Map<string, { data: SAMSearchResponse; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Rate limiting for SAM.gov API calls
 */
function checkSAMRateLimit(req: NextRequest): boolean {
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  
  const clientData = samRateLimitMap.get(clientIp as string);
  
  if (!clientData) {
    samRateLimitMap.set(clientIp as string, { count: 1, timestamp: now });
    return true;
  }
  
  // Reset if window has passed
  if (now - clientData.timestamp > SAM_RATE_LIMIT_WINDOW) {
    samRateLimitMap.set(clientIp as string, { count: 1, timestamp: now });
    return true;
  }
  
  // Check if limit exceeded
  if (clientData.count >= SAM_RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  // Increment count
  clientData.count++;
  return true;
}

/**
 * Generate embeddings for text using the configured LLM provider
 */
async function generateEmbeddings(text: string, provider: string = 'openai', apiKey: string): Promise<number[]> {
  // Check cache first
  const cacheKey = `${provider}:${text}`;
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey)!;
  }
  
  let embeddings: number[];
  
  switch (provider) {
    case 'openai':
      embeddings = await generateOpenAIEmbeddings(text, apiKey);
      break;
    case 'huggingface':
      embeddings = await generateHuggingFaceEmbeddings(text, apiKey);
      break;
    default:
      throw new Error(`Embedding provider ${provider} not supported`);
  }
  
  // Cache the result
  embeddingCache.set(cacheKey, embeddings);
  
  return embeddings;
}

/**
 * Generate embeddings using OpenAI API
 */
async function generateOpenAIEmbeddings(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
      encoding_format: 'float',
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`OpenAI Embeddings API error: ${error.error?.message || response.statusText}`);
  }
  
  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Generate embeddings using Hugging Face API
 */
async function generateHuggingFaceEmbeddings(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch('https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: text,
      options: {
        wait_for_model: true,
      },
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Hugging Face Embeddings API error: ${error.error || response.statusText}`);
  }
  
  const data = await response.json();
  return Array.isArray(data[0]) ? data[0] : data;
}

/**
 * Search SAM.gov opportunities
 */
async function searchSAMOpportunities(
  filters: SAMSearchFilters,
  samApiKey: string
): Promise<SAMOpportunity[]> {
  // Generate cache key based on filters
  const cacheKey = generateCacheKey(JSON.stringify(filters), 'sam-search');
  
  // Use cache wrapper
  return withCache(cacheKey, async () => {
    const params = new URLSearchParams();
    
    // Add search parameters
    if (filters.keyword) {
      params.append('q', filters.keyword);
    }
    
    if (filters.startDate) {
      params.append('postedFrom', filters.startDate);
    }
    
    if (filters.endDate) {
      params.append('postedTo', filters.endDate);
    }
    
    if (filters.naicsCode) {
      params.append('naicsCode', filters.naicsCode);
    }
    
    if (filters.state) {
      params.append('state', filters.state);
    }
    
    if (filters.agency) {
      params.append('agency', filters.agency);
    }
    
    if (filters.type) {
      params.append('noticeType', filters.type);
    }
    
    if (filters.setAside) {
      params.append('setAside', filters.setAside);
    }
    
    if (filters.active !== undefined) {
      params.append('active', filters.active.toString());
    }
    
    // Enhanced search parameters
    if (filters.entityName) {
      params.append('entityName', filters.entityName);
    }
    
    if (filters.contractVehicle) {
      params.append('contractVehicle', filters.contractVehicle);
    }
    
    if (filters.classificationCode) {
      params.append('classificationCode', filters.classificationCode);
    }
    
    if (filters.fundingSource) {
      params.append('fundingSource', filters.fundingSource);
    }
    
    if (filters.responseDeadline?.from) {
      params.append('responseDeadlineFrom', filters.responseDeadline.from);
    }
    
    if (filters.responseDeadline?.to) {
      params.append('responseDeadlineTo', filters.responseDeadline.to);
    }
    
    if (filters.estimatedValue?.min) {
      params.append('estimatedValueMin', filters.estimatedValue.min.toString());
    }
    
    if (filters.estimatedValue?.max) {
      params.append('estimatedValueMax', filters.estimatedValue.max.toString());
    }
    
    if (filters.hasAttachments) {
      params.append('hasAttachments', 'true');
    }
    
    params.append('limit', Math.min(filters.limit || 50, 100).toString());
    params.append('offset', (filters.offset || 0).toString());
    
    // Add default parameters
    params.append('includeCount', 'true');
    params.append('format', 'json');
    
    const url = `${SAM_BASE_URL}${SAM_OPPORTUNITIES_ENDPOINT}?${params.toString()}`;
    
    // Log the request for debugging (remove sensitive data)
    console.log('SAM.gov API request:', {
      url: `${SAM_BASE_URL}${SAM_OPPORTUNITIES_ENDPOINT}`,
      params: Object.fromEntries(params.entries()),
      hasApiKey: !!samApiKey
    });
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': samApiKey,
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      const error = await response.text();
      let errorMessage = `SAM.gov API error: ${response.status} ${response.statusText}`;
      
      try {
        const errorJson = JSON.parse(error);
        if (errorJson.errorMessage) {
          errorMessage += ` - ${errorJson.errorMessage}`;
        } else {
          errorMessage += ` - ${error}`;
        }
      } catch {
        errorMessage += ` - ${error}`;
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    
    // Transform SAM.gov response to our format
    return data.opportunitiesData?.map((opportunity: any) => ({
      id: opportunity.noticeId || opportunity.solicitationNumber,
      noticeId: opportunity.noticeId,
      title: opportunity.title,
      description: opportunity.description || '',
      synopsis: opportunity.synopsis || '',
      type: opportunity.type,
      baseType: opportunity.baseType,
      archiveType: opportunity.archiveType,
      archiveDate: opportunity.archiveDate,
      typeOfSetAsideDescription: opportunity.typeOfSetAsideDescription,
      typeOfSetAside: opportunity.typeOfSetAside,
      responseDeadLine: opportunity.responseDeadLine,
      naicsCode: opportunity.naicsCode,
      naicsDescription: opportunity.naicsDescription,
      classificationCode: opportunity.classificationCode,
      active: opportunity.active,
      award: opportunity.award,
      pointOfContact: opportunity.pointOfContact,
      placeOfPerformance: opportunity.placeOfPerformance,
      organizationType: opportunity.organizationType,
      officeAddress: opportunity.officeAddress,
      links: opportunity.links,
      uiLink: opportunity.uiLink,
      relevanceScore: 0, // Will be calculated if semantic search is used
      isFavorite: false,
      tags: [],
    })) || [];
  }, { prefix: 'sam-search', ttl: 1800 }); // Cache for 30 minutes
}

/**
 * Perform semantic search on opportunities
 */
async function performSemanticSearch(
  opportunities: SAMOpportunity[],
  query: string,
  provider: string,
  apiKey: string
): Promise<SAMOpportunity[]> {
  if (!query.trim()) {
    return opportunities;
  }
  
  try {
    // Generate embeddings for the search query
    const queryEmbeddings = await generateEmbeddings(query, provider, apiKey);
    
    // Generate embeddings for each opportunity and calculate similarity
    const opportunitiesWithScores = await Promise.all(
      opportunities.map(async (opportunity) => {
        const text = `${opportunity.title} ${opportunity.description} ${opportunity.synopsis}`;
        const opportunityEmbeddings = await generateEmbeddings(text, provider, apiKey);
        
        const similarity = cosineSimilarity(queryEmbeddings, opportunityEmbeddings);
        
        return {
          ...opportunity,
          relevanceScore: similarity,
        };
      })
    );
    
    // Sort by relevance score (descending) and return top results
    return opportunitiesWithScores
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, 25); // Return top 25 most relevant
      
  } catch (error) {
    console.error('Semantic search error:', error);
    // Fall back to original results if semantic search fails
    return opportunities;
  }
}

/**
 * Main SAM search API handler
 */
export async function GET(req: NextRequest) {
  // Check rate limit
  if (!checkSAMRateLimit(req)) {
    return NextResponse.json({ 
      error: 'Rate limit exceeded. Please try again later.' 
    }, { status: 429 });
  }
  
  try {
    const { searchParams } = new URL(req.url);
    const keyword = searchParams.get('q');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const naicsCode = searchParams.get('naicsCode');
    const state = searchParams.get('state');
    const agency = searchParams.get('agency');
    const type = searchParams.get('type');
    const setAside = searchParams.get('setAside');
    const active = searchParams.get('active');
    const limit = searchParams.get('limit');
    const offset = searchParams.get('offset');
    const semantic = searchParams.get('semantic');
    const provider = searchParams.get('provider') || 'openai';
    const samApiKey = searchParams.get('samApiKey');
    const entityName = searchParams.get('entityName');
    const contractVehicle = searchParams.get('contractVehicle');
    const classificationCode = searchParams.get('classificationCode');
    const fundingSource = searchParams.get('fundingSource');
    const responseDeadlineFrom = searchParams.get('responseDeadlineFrom');
    const responseDeadlineTo = searchParams.get('responseDeadlineTo');
    const estimatedValueMin = searchParams.get('estimatedValueMin');
    const estimatedValueMax = searchParams.get('estimatedValueMax');
    const hasAttachments = searchParams.get('hasAttachments');
    
    // Validate required parameters
    if (!samApiKey) {
      return NextResponse.json({ 
        error: 'SAM API key is required' 
      }, { status: 400 });
    }
    
    // Set default date range if not provided (last 30 days)
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    
    // Format dates as MM/dd/yyyy for SAM.gov API
    const formatDateForSAM = (date: Date) => {
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const year = date.getFullYear();
      return `${month}/${day}/${year}`;
    };
    
    // Convert date string to MM/dd/yyyy format if needed
    const normalizeDate = (dateStr: string | null | undefined): string | undefined => {
      if (!dateStr) return undefined;
      
      // If already in MM/dd/yyyy format, return as is
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
        return dateStr;
      }
      
      // If in YYYY-MM-DD format, convert to MM/dd/yyyy
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [year, month, day] = dateStr.split('-');
        return `${month}/${day}/${year}`;
      }
      
      // Try to parse as Date and format
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return formatDateForSAM(date);
      }
      
      return undefined;
    };
    
    const defaultStartDate = formatDateForSAM(thirtyDaysAgo);
    const defaultEndDate = formatDateForSAM(today);
    
    // Build search filters
    const filters: SAMSearchFilters = {
      keyword: keyword || undefined,
      startDate: normalizeDate(startDate) || defaultStartDate,
      endDate: normalizeDate(endDate) || defaultEndDate,
      naicsCode: naicsCode || undefined,
      state: state || undefined,
      agency: agency || undefined,
      type: type || undefined,
      setAside: setAside || undefined,
      active: active === 'true',
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
      // Enhanced filters
      entityName: entityName || undefined,
      contractVehicle: contractVehicle || undefined,
      classificationCode: classificationCode || undefined,
      fundingSource: fundingSource || undefined,
      responseDeadline: {
        from: normalizeDate(responseDeadlineFrom) || undefined,
        to: normalizeDate(responseDeadlineTo) || undefined,
      },
      estimatedValue: {
        min: estimatedValueMin ? parseFloat(estimatedValueMin) : undefined,
        max: estimatedValueMax ? parseFloat(estimatedValueMax) : undefined,
      },
      hasAttachments: hasAttachments === 'true',
    };
    
    // Create cache key
    const cacheKey = JSON.stringify(filters);
    
    // Check cache first
    const cachedResult = searchResultsCache.get(cacheKey);
    if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_DURATION) {
      return NextResponse.json({
        success: true,
        data: cachedResult.data,
        cached: true,
        timestamp: Date.now(),
      }, { status: 200 });
    }
    
    // Search SAM.gov
    if (!samApiKey) {
      return NextResponse.json({ error: 'SAM API key is required' }, { status: 400 });
    }
    const opportunities = await searchSAMOpportunities(filters, samApiKey);
    
    // Add opportunities to vector store for future semantic search
    if (opportunities.length > 0) {
      try {
        await Promise.all(
          opportunities.slice(0, 10).map(opp => vectorStoreUtils.addOpportunity(opp))
        );
      } catch (error) {
        console.warn('Failed to add opportunities to vector store:', error);
      }
    }
    
    // Perform semantic search if requested and query is provided
    let finalOpportunities = opportunities;
    if (semantic === 'true' && keyword) {
      const llmApiKey = req.headers.get('authorization')?.replace('Bearer ', '');
      if (llmApiKey) {
        finalOpportunities = await performSemanticSearch(
          opportunities,
          keyword,
          provider,
          llmApiKey
        );
      }
    }
    
    // Build response
    const response: SAMSearchResponse = {
      opportunities: finalOpportunities,
      totalRecords: opportunities.length,
      limit: filters.limit || 50,
      offset: filters.offset || 0,
      facets: {
        naicsCodes: [],
        states: [],
        agencies: [],
        types: [],
      },
    };
    
    // Cache the result
    searchResultsCache.set(cacheKey, { data: response, timestamp: Date.now() });
    
    // Return response
    return NextResponse.json({
      success: true,
      data: response,
      timestamp: Date.now(),
    }, { status: 200 });
    
  } catch (error) {
    console.error('SAM search API error:', error);
    
    // Return appropriate error response
    if (error instanceof Error) {
      return NextResponse.json({ 
        error: error.message,
        timestamp: Date.now(),
      }, { status: 500 });
    } else {
      return NextResponse.json({ 
        error: 'An unexpected error occurred',
        timestamp: Date.now(),
      }, { status: 500 });
    }
  }
}

// Cleanup function to remove old cache entries
setInterval(() => {
  const now = Date.now();
  
  // Clean embedding cache (keep last 1000 entries)
  if (embeddingCache.size > 1000) {
    const entries = Array.from(embeddingCache.entries());
    embeddingCache.clear();
    entries.slice(-500).forEach(([key, value]) => {
      embeddingCache.set(key, value);
    });
  }
  
  // Clean search results cache
  Array.from(searchResultsCache.entries()).forEach(([key, value]) => {
    if (now - value.timestamp > CACHE_DURATION) {
      searchResultsCache.delete(key);
    }
  });
}, 5 * 60 * 1000); // Run every 5 minutes

export { SAM_RATE_LIMIT_WINDOW, SAM_RATE_LIMIT_MAX_REQUESTS };