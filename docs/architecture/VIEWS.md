# LLTeacher v2 - View Layer Design

This document outlines the design principles and implementation details for the view layer of the LLTeacher v2 application, following the testable-first architecture.

## Testable-First View Architecture

### Core Principles

1. **Separation of Concerns**:
   - Views are responsible for handling HTTP requests and returning responses
   - Business logic is delegated to the service layer
   - Data preparation is separated from rendering

2. **Typed Data Contracts**:
   - All data passed to templates is structured through typed dataclasses
   - Clear input/output interfaces for all view methods

3. **Pure Data Methods**:
   - View data preparation methods are pure functions that can be tested independently
   - No side effects in data preparation methods

4. **Permission Enforcement**:
   - Consistent permission checking through decorators and mixins
   - Clear access control rules for each view

5. **Error Handling**:
   - Comprehensive error handling with user-friendly messages
   - Proper HTTP status codes for different error conditions

## View Implementation Pattern

For each view, follow this consistent pattern:

```python
from dataclasses import dataclass
from typing import List, Optional
from django.views import View
from django.shortcuts import render, redirect
from django.http import HttpRequest, HttpResponse
from django.contrib.auth.decorators import login_required
from django.utils.decorators import method_decorator

@dataclass
class ViewData:
    # Define typed data structure to pass to template
    # All fields should be typed
    field1: str
    field2: int
    items: List[Any]
    # ...

@method_decorator(login_required, name='dispatch')
class ExampleView(View):
    """View description."""
    
    def get(self, request: HttpRequest) -> HttpResponse:
        """Handle GET requests."""
        # Get typed data for rendering
        data = self._get_view_data(request.user)
        
        # Render with data
        return render(request, 'example_template.html', {'data': data})
    
    def post(self, request: HttpRequest) -> HttpResponse:
        """Handle POST requests."""
        # Parse input data (with validation)
        input_data = self._parse_input_data(request)
        
        # Process data using service
        result = self._process_data(request.user, input_data)
        
        # Handle result (redirect or render)
        if result.success:
            messages.success(request, "Operation successful.")
            return redirect('success-url')
        else:
            messages.error(request, result.error or "Operation failed.")
            return self.get(request)
    
    def _get_view_data(self, user) -> ViewData:
        """Prepare data for rendering - pure function, easily testable."""
        # Use services to get data
        service_result = SomeService.get_data()
        
        # Transform to view-specific data
        return ViewData(
            field1=service_result.field,
            field2=123,
            items=[item for item in service_result.items]
        )
    
    def _parse_input_data(self, request: HttpRequest) -> InputData:
        """Parse and validate input data - pure function, easily testable."""
        try:
            # Extract and validate data
            return InputData(
                field1=request.POST.get('field1'),
                field2=int(request.POST.get('field2', 0))
            )
        except Exception as e:
            # Handle parsing errors
            return InputData(error=str(e))
    
    def _process_data(self, user, data: InputData) -> ProcessResult:
        """Process data using service - pure function, easily testable."""
        if data.error:
            return ProcessResult(success=False, error=data.error)
            
        try:
            # Use service to process data
            return SomeService.process_data(user, data)
        except Exception as e:
            return ProcessResult(success=False, error=str(e))
```

## Views by App

### 1. Accounts App

#### User Registration View

```python
@dataclass
class RegistrationFormData:
    username: str
    email: str
    password: str
    confirm_password: str
    role: str  # 'teacher' or 'student'
    errors: Dict[str, str] = None

@dataclass
class RegistrationResult:
    success: bool
    user_id: Optional[UUID] = None
    error: Optional[str] = None
```

#### User Login View

```python
@dataclass
class LoginFormData:
    username: str
    password: str
    next_url: Optional[str] = None
    errors: Dict[str, str] = None

@dataclass
class LoginResult:
    success: bool
    redirect_url: str
    error: Optional[str] = None
```

#### Profile Management View

```python
@dataclass
class ProfileData:
    user_id: UUID
    username: str
    email: str
    first_name: str
    last_name: str
    role: str  # 'teacher' or 'student'
    joined_date: datetime
    
    # Teacher-specific fields
    courses_created: int = 0
    
    # Student-specific fields
    submissions_count: int = 0
    completed_sections: int = 0
```

### 2. Homeworks App

#### Homework List View

```python
@dataclass
class HomeworkListItem:
    id: UUID
    title: str
    description: str
    due_date: Any  # datetime
    section_count: int
    created_at: Any  # datetime
    is_overdue: bool
    progress: Optional[List[Dict[str, Any]]] = None

@dataclass
class HomeworkListData:
    homeworks: List[HomeworkListItem]
    user_type: str  # 'teacher', 'student', or 'unknown'
    total_count: int
    has_progress_data: bool
```

#### Homework Creation View

```python
@dataclass
class SectionFormData:
    title: str
    content: str
    order: int
    solution: Optional[str] = None
    errors: Dict[str, str] = None

@dataclass
class HomeworkFormData:
    title: str
    description: str
    due_date: Any  # datetime
    sections: List[SectionFormData]
    llm_config: Optional[UUID] = None
    errors: Dict[str, str] = None
```

#### Homework Detail View

```python
@dataclass
class SectionDetailData:
    id: UUID
    title: str
    content: str
    order: int
    has_solution: bool
    solution_content: Optional[str]

@dataclass
class HomeworkDetailData:
    id: UUID
    title: str
    description: str
    due_date: Any  # datetime
    created_by: UUID
    created_by_name: str
    created_at: Any  # datetime
    sections: List[SectionDetailData]
    is_overdue: bool
    llm_config: Optional[Dict[str, Any]] = None
```

#### Section Detail View

```python
@dataclass
class SectionDetailViewData:
    homework_id: UUID
    homework_title: str
    section_id: UUID
    section_title: str
    section_content: str
    section_order: int
    has_solution: bool
    solution_content: Optional[str]
    conversations: Optional[List[Dict[str, Any]]] = None
    submission: Optional[Dict[str, Any]] = None
    is_teacher: bool = False
    is_student: bool = False
```

### 3. Conversations App

#### Conversation Start View

```python
@dataclass
class ConversationStartFormData:
    section_id: UUID
    section_title: str
    errors: Dict[str, str] = None

@dataclass
class ConversationStartViewData:
    section_id: UUID
    section_title: str
    homework_id: UUID
    homework_title: str
```
    
#### Conversation Detail View

```python
@dataclass
class MessageViewData:
    id: UUID
    content: str
    message_type: str
    timestamp: datetime
    is_from_student: bool
    is_from_ai: bool
    is_system_message: bool
    css_class: str  # For styling

@dataclass
class ConversationDetailData:
    id: UUID
    section_id: UUID
    section_title: str
    homework_id: UUID
    homework_title: str
    messages: List[MessageViewData]
    can_submit: bool
    is_teacher_test: bool
```

#### Message Send View

```python
@dataclass
class MessageSendFormData:
    conversation_id: UUID
    content: str
    message_type: str = 'student'
    errors: Dict[str, str] = None

@dataclass
class MessageSendResult:
    success: bool
    conversation_id: UUID
    error: Optional[str] = None
```

#### Section Submit View

```python
@dataclass
class SectionSubmitFormData:
    section_id: UUID
    conversation_id: UUID
    errors: Dict[str, str] = None

@dataclass
class SectionSubmitViewData:
    section_id: UUID
    section_title: str
    conversations: List[Dict[str, Any]]
    existing_submission: Optional[Dict[str, Any]] = None
```

### 4. LLM App

#### LLM Config List View

```python
@dataclass
class LLMConfigListItem:
    id: UUID
    name: str
    model_name: str
    is_default: bool
    is_active: bool
    created_at: datetime

@dataclass
class LLMConfigListData:
    configs: List[LLMConfigListItem]
    total_count: int
    has_default: bool
```

#### LLM Config Create/Edit View

```python
@dataclass
class LLMConfigFormData:
    name: str
    model_name: str
    api_key: str
    base_prompt: str
    temperature: float = 0.7
    max_tokens: int = 1000
    is_default: bool = False
    is_active: bool = True
    errors: Dict[str, str] = None
```

## Permission System Integration

### Permission Decorators

Each view will use appropriate permission decorators:

1. **Base Authentication**:
   ```python
   @method_decorator(login_required, name='dispatch')
   ```

2. **Role-Based Access**:
   ```python
   @method_decorator(teacher_required, name='dispatch')
   @method_decorator(student_required, name='dispatch')
   ```

3. **Object-Level Permissions**:
   ```python
   @method_decorator(homework_owner_required, name='dispatch')
   @method_decorator(section_access_required, name='dispatch')
   ```

### Permission Mixins

For views that need more complex permission logic:

```python
class HomeworkAccessMixin:
    """Mixin to verify homework access permissions."""
    
    def dispatch(self, request, *args, **kwargs):
        homework = self.get_object()
        teacher, student = get_teacher_or_student(request.user)
        
        if teacher and homework.created_by == teacher:
            # Teacher owns homework - allow access
            return super().dispatch(request, *args, **kwargs)
        elif student and not homework.is_deleted:
            # Student accessing visible homework - allow access
            return super().dispatch(request, *args, **kwargs)
        else:
            # Deny access
            return HttpResponseForbidden("You don't have access to this homework.")
```

## Error Handling

1. **Form Validation**:
   - Each form data class includes an errors dictionary
   - Validation happens in the _parse_input_data methods
   - Errors are collected and returned to the template

2. **Service Errors**:
   - Service methods return typed results with success/error fields
   - Views check service results and display appropriate messages

3. **Permission Errors**:
   - Permission failures return HttpResponseForbidden with clear messages

4. **Not Found Errors**:
   - Object retrieval uses get_object_or_404 for automatic 404 handling

## Templates and Rendering

Each view will have a corresponding template:

1. **Base Template**:
   - `base.html` - Main layout template with common elements

2. **Accounts Templates**:
   - `accounts/login.html`
   - `accounts/register.html`
   - `accounts/profile.html`

3. **Homeworks Templates**:
   - `homeworks/list.html`
   - `homeworks/detail.html`
   - `homeworks/create.html`
   - `homeworks/edit.html`
   - `homeworks/section_detail.html`

4. **Conversations Templates**:
   - `conversations/detail.html`
   - `conversations/list.html`
   - `conversations/submit.html`

5. **LLM Templates**:
   - `llm/config_list.html`
   - `llm/config_form.html`

## AJAX and Interactive Features

For interactive features like real-time messaging, the views will support both full-page renders and JSON responses:

```python
def get(self, request: HttpRequest) -> HttpResponse:
    data = self._get_view_data(request.user)
    
    # Check if AJAX request
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return JsonResponse({
            'html': render_to_string('partial_template.html', {'data': data}),
            'data': dataclasses.asdict(data)
        })
    else:
        return render(request, 'full_template.html', {'data': data})
```

## Testing Strategy

1. **Unit Tests**:
   - Test each _get_view_data, _parse_input_data, and _process_data method in isolation
   - Mock service calls to test data transformation
   - Verify correct data structures are returned

2. **Integration Tests**:
   - Test GET and POST methods with RequestFactory
   - Verify correct templates are used
   - Check redirects and message handling

3. **Permission Tests**:
   - Test each permission decorator and mixin
   - Verify access is granted/denied appropriately

4. **Form Validation Tests**:
   - Test form data validation logic
   - Verify correct error messages are returned

## Implementation Plan

1. **Phase 1**: Implement core view structure and base templates
2. **Phase 2**: Implement accounts views and authentication
3. **Phase 3**: Implement homework management views
4. **Phase 4**: Implement conversation and submission views
5. **Phase 5**: Implement LLM configuration views
6. **Phase 6**: Add tests for all views
7. **Phase 7**: Enhance UI with AJAX and interactive features

## Conclusion

The view layer follows the testable-first architecture with clear separation between data preparation, request handling, and rendering. This approach ensures that views remain focused on their primary responsibilities while delegating business logic to the service layer. The consistent structure will make the views easy to test, maintain, and extend.