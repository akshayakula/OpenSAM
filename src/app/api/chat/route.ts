import { NextRequest, NextResponse } from 'next/server';
import { LLMProvider, LLMMessage, LLMResponse, CompanyProfile } from '@/types';
import { vectorStoreServerUtils } from '@/lib/vectorStore-server';
import { chatWithRAG, findMatchingOpportunities } from '@/lib/chat-rag';

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitMap = new Map<string, { count: number; timestamp: number }>();

// LLM Provider configurations
const LLM_CONFIGS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    chatEndpoint: '/chat/completions',
    headers: (apiKey: string) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    chatEndpoint: '/messages',
    headers: (apiKey: string) => ({
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }),
  },
  huggingface: {
    baseUrl: 'https://api-inference.huggingface.co/models',
    chatEndpoint: '', // Will be constructed per model
    headers: (apiKey: string) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
  },
};

// System prompt for SAM.gov expertise
const SYSTEM_PROMPT = `You are OpenSAM AI, an expert assistant for SAM.gov (System for Award Management) government contracting opportunities. Your expertise includes:

- Government contracting processes and terminology
- SAM.gov opportunity analysis and search
- Contract award history and trends
- NAICS codes and industry classifications
- Set-aside programs and small business categories
- Federal procurement regulations (FAR)
- Proposal writing and past performance evaluation

When users ask about contracting opportunities, provide detailed, accurate information. If you need to search for specific opportunities, indicate that you'll search SAM.gov data. Always prioritize accuracy and compliance with federal regulations.

Keep responses concise but comprehensive, and always consider the business context of government contracting.

You have access to a local vector database of SAM.gov opportunities, entities, and chat history. Use this context to provide more relevant and personalized responses.`;

/**
 * Rate limiting middleware
 */
function checkRateLimit(req: NextRequest): boolean {
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const now = Date.now();
  
  const clientData = rateLimitMap.get(clientIp as string);
  
  if (!clientData) {
    rateLimitMap.set(clientIp as string, { count: 1, timestamp: now });
    return true;
  }
  
  // Reset if window has passed
  if (now - clientData.timestamp > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(clientIp as string, { count: 1, timestamp: now });
    return true;
  }
  
  // Check if limit exceeded
  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  // Increment count
  clientData.count++;
  return true;
}

/**
 * Format messages for OpenAI API
 */
function formatOpenAIMessages(messages: LLMMessage[]): any[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }))
  ];
}

/**
 * Format messages for Anthropic API
 */
function formatAnthropicMessages(messages: LLMMessage[]): any {
  const userMessages = messages.filter(msg => msg.role !== 'system');
  return {
    system: SYSTEM_PROMPT,
    messages: userMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }))
  };
}

/**
 * Format messages for Hugging Face API
 */
function formatHuggingFaceMessages(messages: LLMMessage[]): any {
  const conversationText = messages.map(msg => {
    const prefix = msg.role === 'user' ? 'Human: ' : 'Assistant: ';
    return prefix + msg.content;
  }).join('\n\n');
  
  return {
    inputs: `${SYSTEM_PROMPT}\n\n${conversationText}\n\nAssistant:`,
    parameters: {
      max_new_tokens: 1000,
      temperature: 0.7,
      return_full_text: false,
    }
  };
}

/**
 * Call OpenAI API
 */
async function callOpenAI(
  messages: LLMMessage[], 
  model: string, 
  apiKey: string,
  temperature: number = 0.7,
  maxTokens: number = 1000
): Promise<LLMResponse> {
  const config = LLM_CONFIGS.openai;
  
  const payload = {
    model,
    messages: formatOpenAIMessages(messages),
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  
  const response = await fetch(`${config.baseUrl}${config.chatEndpoint}`, {
    method: 'POST',
    headers: config.headers(apiKey),
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    content: data.choices[0].message.content,
    usage: data.usage,
    model: data.model,
    provider: 'openai',
  };
}

/**
 * Call Anthropic API
 */
async function callAnthropic(
  messages: LLMMessage[], 
  model: string, 
  apiKey: string,
  temperature: number = 0.7,
  maxTokens: number = 1000
): Promise<LLMResponse> {
  const config = LLM_CONFIGS.anthropic;
  
  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    ...formatAnthropicMessages(messages),
  };
  
  const response = await fetch(`${config.baseUrl}${config.chatEndpoint}`, {
    method: 'POST',
    headers: config.headers(apiKey),
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    content: data.content[0].text,
    usage: {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    },
    model: data.model,
    provider: 'anthropic',
  };
}

/**
 * Call Hugging Face API
 */
async function callHuggingFace(
  messages: LLMMessage[], 
  model: string, 
  apiKey: string,
  temperature: number = 0.7,
  maxTokens: number = 1000
): Promise<LLMResponse> {
  const config = LLM_CONFIGS.huggingface;
  
  const payload = formatHuggingFaceMessages(messages);
  payload.parameters.temperature = temperature;
  payload.parameters.max_new_tokens = maxTokens;
  
  const response = await fetch(`${config.baseUrl}/${model}`, {
    method: 'POST',
    headers: config.headers(apiKey),
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Hugging Face API error: ${error.error || response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    content: Array.isArray(data) ? data[0].generated_text : data.generated_text,
    usage: {
      prompt_tokens: 0, // HF doesn't provide token counts
      completion_tokens: 0,
      total_tokens: 0,
    },
    model,
    provider: 'huggingface',
  };
}

/**
 * Main chat API handler
 */
export async function POST(req: NextRequest) {
  // Check rate limit
  if (!checkRateLimit(req)) {
    return NextResponse.json({ 
      error: 'Rate limit exceeded. Please try again later.' 
    }, { status: 429 });
  }
  
  try {
    const { model, messages, context, companyProfile } = await req.json();
    
    // Validate input
    if (!model || !messages || !Array.isArray(messages)) {
      return NextResponse.json({ 
        error: 'Invalid request. Model and messages are required.' 
      }, { status: 400 });
    }
    
    // Parse provider and model
    const [provider, modelName] = model.split(':');
    
    if (!provider || !modelName) {
      return NextResponse.json({ 
        error: 'Invalid model format. Use "provider:model" format.' 
      }, { status: 400 });
    }
    
    // Validate provider
    if (!['openai', 'anthropic', 'huggingface'].includes(provider)) {
      return NextResponse.json({ 
        error: 'Invalid provider. Supported providers: openai, anthropic, huggingface.' 
      }, { status: 400 });
    }
    
    // Get API key from headers, context, or server environment
    let apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || 
                 context?.apiKey;
    
    // If API key is "server-configured", use environment variable
    if (apiKey === 'server-configured') {
      apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.HUGGINGFACE_API_KEY || '';
    }
    
    if (!apiKey) {
      return NextResponse.json({ 
        error: 'API key is required.' 
      }, { status: 401 });
    }
    
    // Test mode for validation
    if (context?.test) {
      return NextResponse.json({ 
        success: true, 
        message: 'API key validation successful' 
      }, { status: 200 });
    }
    
    // Call appropriate LLM provider with RAG if company profile is provided
    let response: LLMResponse;
    
    if (companyProfile) {
      // Use RAG with company profile
      const ragResult = await chatWithRAG(
        messages[messages.length - 1].content, // Get the last user message
        companyProfile,
        async (systemPrompt: string, userPrompt: string) => {
          // Create a custom LLM function that uses the selected provider
          const ragMessages = [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: userPrompt }
          ];
          
          switch (provider as LLMProvider) {
            case 'openai':
              const openaiResponse = await callOpenAI(
                ragMessages, 
                modelName, 
                apiKey, 
                context?.temperature, 
                context?.maxTokens
              );
              return openaiResponse.content;
              
            case 'anthropic':
              const anthropicResponse = await callAnthropic(
                ragMessages, 
                modelName, 
                apiKey, 
                context?.temperature, 
                context?.maxTokens
              );
              return anthropicResponse.content;
              
            case 'huggingface':
              const huggingfaceResponse = await callHuggingFace(
                ragMessages, 
                modelName, 
                apiKey, 
                context?.temperature, 
                context?.maxTokens
              );
              return huggingfaceResponse.content;
              
            default:
              throw new Error(`Unsupported provider: ${provider}`);
          }
        }
      );
      
      // Create response with RAG context
      response = {
        content: ragResult.response,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: modelName,
        provider: provider as LLMProvider,
        ragContext: {
          opportunities: ragResult.opportunities,
          companyProfile: companyProfile
        }
      };
    } else {
      // Standard chat without RAG
      switch (provider as LLMProvider) {
        case 'openai':
          response = await callOpenAI(
            messages, 
            modelName, 
            apiKey, 
            context?.temperature, 
            context?.maxTokens
          );
          break;
          
        case 'anthropic':
          response = await callAnthropic(
            messages, 
            modelName, 
            apiKey, 
            context?.temperature, 
            context?.maxTokens
          );
          break;
          
        case 'huggingface':
          response = await callHuggingFace(
            messages, 
            modelName, 
            apiKey, 
            context?.temperature, 
            context?.maxTokens
          );
          break;
          
        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }
    }
    
    // Return response
    return NextResponse.json({
      success: true,
      data: response,
      timestamp: Date.now(),
    }, { status: 200 });
    
  } catch (error) {
    console.error('Chat API error:', error);
    
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

// Rate limit configuration for internal use only