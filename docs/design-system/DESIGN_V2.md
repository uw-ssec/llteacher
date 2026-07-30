# LLTeacher v2 - System Design Document

## Executive Summary

LLTeacher v2 is a redesigned version of the AI-assisted educational platform that addresses the critical architectural flaws of v1 while maintaining the core innovative concept. The system allows teachers to create homework assignments with multiple sections, each with optional solutions, and students to interact with AI tutors to work through these sections individually.

## Core Changes from v1

### 1. **Data Model Restructuring**
- **UUID Primary Keys**: All models now use UUIDs instead of integers
- **Sectioned Homework**: Homework is split into 1-20 sections, each with optional solutions
- **Simplified Submission Model**: Submission tracks the selected conversation, which in turn tracks the assignment
- **Removed Grading**: No teacher feedback or grades stored in the system
- **Streamlined Models**: Removed unnecessary fields like bio, progress_notes, and soft delete complexity

### 2. **Improved Architecture**
- **Testable-First Approach**: Views return typed dataclasses for clear data contracts and easier testing
- **Service Layer**: Business logic extracted from views into dedicated service classes
- **Centralized Permissions**: Unified permission system with decorators
- **Better Data Integrity**: Cleaner relationships and constraints
- **Performance Optimizations**: Proper database queries and caching strategy

### 3. **Enhanced User Experience**
- **Streamlined Workflows**: Reduced redirects and state changes
- **Progress Tracking**: Section completion and submission status
- **Flexible Navigation**: Students can work on sections in any order
- **Teacher Testing**: Teachers can test their homework assignments with the AI tutor

## System Architecture

### Technology Stack
- **Backend**: Django 5.2.4+ with Python 3.12+
- **Database**: SQLite (development and production)
- **Package Management**: uv for dependency management
- **Frontend**: Django templates with Bootstrap 5
- **LLM Integration**: OpenAI/Claude API with configurable parameters


### Project Structure
```
2_llteacher/
├── apps/                   # Django applications
│   ├── accounts/           # User management and authentication
│   ├── homeworks/          # Homework and section management
│   ├── conversations/      # AI conversation handling and submissions
│   └── llm/                # LLM configuration and services
├── core/                   # Shared utilities and base classes
├── services/               # Business logic service layer
├── permissions/            # Permission decorators and utilities
├── llteacher/              # Main Django project configuration
├── templates/              # Django templates
├── static/                 # Static files (CSS, JS, images)
├── manage.py               # Django management script
└── pyproject.toml          # Root project configuration
```

We are using uv workspaces to manage everything.

@https://docs.astral.sh/uv/concepts/projects/workspaces/

Each app will be in a separate workspace along with core, services, and permissions.

Each app (including the main application `llteacher`) need to be structured with a `src` directory and inside the `src` directory another directory with the name of the python module.



## Data Model Design

### Simplified Data Flow

The new model follows a clean, hierarchical structure:
- **Homework** contains multiple **Sections**
- **Sections** can have optional **Solutions** and multiple **Conversations**
- **Students** create **Conversations** with sections
- **Submissions** track which conversation represents the final work (section is derived from conversation)

This eliminates the complex nullable foreign key relationships from v1 and creates a clear, maintainable data structure.

### 1. User Management (`accounts` app)

```python
import uuid
from django.db import models
from django.contrib.auth.models import AbstractUser

class User(AbstractUser):
    """Custom user model with UUID primary key."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    
    class Meta:
        db_table = 'accounts_user'

class Teacher(models.Model):
    """Teacher profile with one-to-one relationship to User."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='teacher_profile')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'accounts_teacher'

class Student(models.Model):
    """Student profile with one-to-one relationship to User."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='student_profile')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'accounts_student'
```

### 2. Homework Management (`homeworks` app)

```python
import uuid
from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator

class Homework(models.Model):
    """Homework assignment with multiple sections."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=200)
    description = models.TextField()
    created_by = models.ForeignKey('accounts.Teacher', on_delete=models.CASCADE, related_name='homeworks_created')
    due_date = models.DateTimeField()
    llm_config = models.ForeignKey('llm.LLMConfig', on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'homeworks_homework'
        ordering = ['-created_at']
    
    def __str__(self):
        return self.title
    
    @property
    def section_count(self):
        return self.sections.count()
    
    @property
    def is_overdue(self):
        from django.utils import timezone
        return timezone.now() > self.due_date

class Section(models.Model):
    """Individual section within a homework assignment."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    homework = models.ForeignKey(Homework, on_delete=models.CASCADE, related_name='sections')
    title = models.CharField(max_length=200)
    content = models.TextField()
    order = models.PositiveIntegerField(validators=[MinValueValidator(1), MaxValueValidator(20)])
    solution = models.OneToOneField('SectionSolution', on_delete=models.SET_NULL, null=True, blank=True, related_name='section')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'homeworks_section'
        ordering = ['order']
        unique_together = ['homework', 'order']
    
    def __str__(self):
        return f"{self.homework.title} - Section {self.order}: {self.title}"
    
class SectionSolution(models.Model):
    """Teacher-provided solution for a section."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'homeworks_section_solution'
    
    def __str__(self):
        return f"Solution for {self.section}"
```

### 3. Conversation Management (`conversations` app)

**Flexible Message Types**: The Message model supports any string value for message types, allowing for extensible conversation handling. Common types include:
- `student`: Regular student text messages
- `ai`: AI tutor responses
- `r_code`: R code submitted by students
- `code_execution`: Results of code execution
- `file_upload`: File attachments
- `system`: System notifications or status updates

```python
import uuid
from django.db import models
from django.core.validators import MinLengthValidator

class Conversation(models.Model):
    """AI conversation between user and LLM for a specific section."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey('accounts.User', on_delete=models.CASCADE, related_name='conversations')
    section = models.ForeignKey('homeworks.Section', on_delete=models.CASCADE, related_name='conversations')
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'conversations_conversation'
        ordering = ['-created_at']
    
    def __str__(self):
        user_type = "Teacher" if self.is_teacher_test else "Student"
        return f"{user_type} conversation {self.id} - {self.user.username} on {self.section}"
    
    def soft_delete(self):
        """Soft delete the conversation."""
        from django.utils import timezone
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.save()
    
    @property
    def message_count(self):
        return self.messages.count()
    
    @property
    def is_teacher_test(self):
        """Check if this is a teacher test conversation."""
        return hasattr(self.user, 'teacher_profile')
    
    @property
    def is_student_conversation(self):
        """Check if this is a student conversation."""
        return hasattr(self.user, 'student_profile')

class Message(models.Model):
    """Individual message in a conversation."""
    
    # Common message types (for reference, but not enforced)
    MESSAGE_TYPE_STUDENT = 'student'
    MESSAGE_TYPE_AI = 'ai'
    MESSAGE_TYPE_R_CODE = 'code'
    MESSAGE_TYPE_FILE_UPLOAD = 'file_upload'
    MESSAGE_TYPE_CODE_EXECUTION = 'code_execution'
    MESSAGE_TYPE_SYSTEM = 'system'
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name='messages')
    content = models.TextField(validators=[MinLengthValidator(1)])
    message_type = models.CharField(max_length=50, help_text="Type of message (e.g., 'student', 'ai', 'r_code', 'file_upload', etc.)")
    timestamp = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'conversations_message'
        ordering = ['timestamp']
    
    def __str__(self):
        return f"{self.message_type} message at {self.timestamp}"
    
    @property
    def is_from_student(self):
        """Check if this is a student message."""
        return self.message_type in [self.MESSAGE_TYPE_STUDENT, self.MESSAGE_TYPE_R_CODE, 
                                   self.MESSAGE_TYPE_FILE_UPLOAD, self.MESSAGE_TYPE_CODE_EXECUTION]
    
    @property
    def is_from_ai(self):
        """Check if this is an AI response."""
        return self.message_type == self.MESSAGE_TYPE_AI
    
    @property
    def is_system_message(self):
        """Check if this is a system message."""
        return self.message_type == self.MESSAGE_TYPE_SYSTEM

class Submission(models.Model):
    """Student submission for a specific section."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.OneToOneField(Conversation, on_delete=models.CASCADE, related_name='submission')
    submitted_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'conversations_submission'
        ordering = ['-submitted_at']
    
    def __str__(self):
        return f"Submission by {self.conversation.user.username} for {self.conversation.section}"
    
    @property
    def section(self):
        """Get the section through the conversation."""
        return self.conversation.section
    
    @property
    def student(self):
        """Get the student through the conversation."""
        return self.conversation.user.student_profile
    
    def clean(self):
        """Ensure only one submission per student per section."""
        from django.core.exceptions import ValidationError
        
        # Check if another submission exists for the same student and section
        existing_submission = Submission.objects.filter(
            conversation__user=self.conversation.user,
            conversation__section=self.conversation.section
        ).exclude(id=self.id)
        
        if existing_submission.exists():
            raise ValidationError("Student already has a submission for this section.")
```

### 4. LLM Configuration (`llm` app)

**Simplified Configuration**: The LLMConfig model focuses on essential parameters without provider complexity. This assumes you're using a single, reliable LLM service (like OpenAI) and allows teachers to configure model behavior and prompts for their specific homework needs.

```python
import uuid
from django.db import models

class LLMConfig(models.Model):
    """Configuration for LLM integration."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100, unique=True)
    model_name = models.CharField(max_length=100, help_text="LLM model to use (e.g., 'gpt-4', 'gpt-3.5-turbo')")
    api_key_variable = models.CharField(max_length=100, help_text="Environment variable name for API key")
    base_prompt = models.TextField(help_text="Base prompt template for AI tutor")
    temperature = models.FloatField(default=0.7, validators=[MinValueValidator(0.0), MaxValueValidator(2.0)])
    max_tokens = models.PositiveIntegerField(default=1000)
    is_default = models.BooleanField(default=False, unique=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'llm_config'
    
    def __str__(self):
        return f"{self.name} ({self.model_name})"
    
    def save(self, *args, **kwargs):
        """Ensure only one default config exists."""
        if self.is_default:
            LLMConfig.objects.filter(is_default=True).update(is_default=False)
        super().save(*args, **kwargs)
```

## Testable-First Architecture

### Overview

The system follows a testable-first approach where views return typed dataclasses instead of mixing business logic with presentation. This ensures:

1. **Separation of Concerns**: Business logic is separate from rendering
2. **Easy Testing**: Data generation methods can be tested independently
3. **Type Safety**: Clear data contracts with dataclasses
4. **Reusability**: Same data can be used for HTML, JSON, or other formats
5. **Maintainability**: Easy to modify data structure without touching templates

### Core Principles

1. **Typed Data Contracts**: Define clear dataclasses for all view data
2. **Pure Data Methods**: Create methods that return typed data independently of rendering
3. **Separated Rendering**: Views simply pass typed data to templates
4. **Testable Components**: Each data generation method can be unit tested
5. **Service Composition**: Views compose service calls rather than implementing logic

### Implementation Pattern

```python
from dataclasses import dataclass
from typing import List, Optional
from django.http import HttpRequest

# 1. Define typed data contracts
@dataclass
class ItemData:
    id: str
    title: str
    # Other fields...

@dataclass
class ViewData:
    items: List[ItemData]
    total_count: int
    # Other fields...

class ExampleView(View):
    def get(self, request: HttpRequest):
        # 2. Get typed data
        data = self._get_view_data(request.user)
        
        # 3. Simple render call
        return render(request, 'template.html', {'data': data})
    
    def _get_view_data(self, user) -> ViewData:
        # 4. Pure data method - easy to test!
        # This method has no side effects and returns typed data
        # ... business logic here ...
        return ViewData(items=items, total_count=len(items))
```

## Service Layer Design

### 1. Homework Service

```python
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from django.db import transaction
from django.utils import timezone
from uuid import UUID
from .models import Homework, Section, SectionSolution

# Typed data contracts
@dataclass
class SectionCreateData:
    title: str
    content: str
    order: int
    solution: Optional[str] = None

@dataclass
class HomeworkCreateData:
    title: str
    description: str
    due_date: Any  # datetime
    sections: List[SectionCreateData]
    llm_config: Optional[UUID] = None

@dataclass
class HomeworkCreateResult:
    homework_id: UUID
    section_ids: List[UUID]
    success: bool = True
    error: Optional[str] = None

@dataclass
class SectionProgressData:
    section_id: UUID
    title: str
    order: int
    status: str  # 'not_started', 'in_progress', 'submitted', 'overdue'
    conversation_id: Optional[UUID] = None

@dataclass
class HomeworkProgressData:
    homework_id: UUID
    sections_progress: List[SectionProgressData]
    completed_sections: int = 0
    total_sections: int = 0
    
    def __post_init__(self):
        self.total_sections = len(self.sections_progress)
        self.completed_sections = sum(1 for s in self.sections_progress if s.status == 'submitted')

class HomeworkService:
    """Service class for homework-related business logic."""
    
    @staticmethod
    def create_homework_with_sections(data: HomeworkCreateData, teacher) -> HomeworkCreateResult:
        """Create homework with multiple sections."""
        try:
            with transaction.atomic():
                # Create homework
                homework = Homework.objects.create(
                    title=data.title,
                    description=data.description,
                    due_date=data.due_date,
                    created_by=teacher,
                    llm_config=data.llm_config
                )
                
                # Create sections
                section_ids = []
                for section_data in data.sections:
                    section = Section.objects.create(
                        homework=homework,
                        title=section_data.title,
                        content=section_data.content,
                        order=section_data.order
                    )
                    
                    # Create solution if provided
                    if section_data.solution:
                        solution = SectionSolution.objects.create(
                            content=section_data.solution
                        )
                        section.solution = solution
                        section.save()
                    
                    section_ids.append(section.id)
                
                return HomeworkCreateResult(
                    homework_id=homework.id,
                    section_ids=section_ids
                )
        except Exception as e:
            # Return failure result with error
            return HomeworkCreateResult(
                homework_id=None,  # type: ignore
                section_ids=[],
                success=False,
                error=str(e)
            )
    
    @staticmethod
    def get_student_homework_progress(student, homework) -> HomeworkProgressData:
        """Get student's progress on a specific homework."""
        sections = homework.sections.order_by('order')
        progress_items = []
        
        for section in sections:
            try:
                submission = Submission.objects.filter(
                    conversation__user=student.user,
                    conversation__section=section
                ).first()
                
                if submission:
                    status = 'submitted'
                    conversation_id = submission.conversation.id
                else:
                    # Check if due date has passed for auto-submission
                    if homework.is_overdue:
                        status = 'overdue'
                        conversation_id = None
                    else:
                        status = 'not_started'
                        conversation_id = None
            except Exception:
                status = 'not_started'
                conversation_id = None
            
            progress_items.append(SectionProgressData(
                section_id=section.id,
                title=section.title,
                order=section.order,
                status=status,
                conversation_id=conversation_id
            ))
        
        return HomeworkProgressData(
            homework_id=homework.id,
            sections_progress=progress_items
        )
```

### 2. Conversation Service

```python
from dataclasses import dataclass
from typing import List, Optional, Tuple, Any
from datetime import datetime
from uuid import UUID
from django.db import transaction
from django.contrib.auth import get_user_model
from .models import Conversation, Message
from homeworks.models import Section
from llm.services import LLMService

User = get_user_model()

@dataclass
class MessageData:
    id: UUID
    content: str
    message_type: str
    timestamp: datetime
    is_from_student: bool
    is_from_ai: bool
    is_system_message: bool

@dataclass
class ConversationData:
    id: UUID
    user_id: UUID
    section_id: UUID
    section_title: str
    created_at: datetime
    updated_at: datetime
    is_teacher_test: bool
    is_student_conversation: bool
    messages: Optional[List[MessageData]] = None

@dataclass
class ConversationStartResult:
    conversation_id: UUID
    initial_message_id: UUID
    section_id: UUID
    success: bool = True
    error: Optional[str] = None

@dataclass
class MessageSendResult:
    user_message_id: Optional[UUID] = None
    ai_message_id: Optional[UUID] = None
    ai_response: Optional[str] = None
    success: bool = True
    error: Optional[str] = None

@dataclass
class CodeExecutionResult:
    code_message_id: Optional[UUID] = None
    result_message_id: Optional[UUID] = None
    has_error: bool = False
    success: bool = True
    error: Optional[str] = None

class ConversationService:
    """Service class for conversation-related business logic."""
    
    @staticmethod
    def start_conversation(user: User, section: Section) -> ConversationStartResult:
        """Start a new conversation for a user on a section."""
        try:
            # Create conversation
            conversation = Conversation.objects.create(
                user=user,
                section=section
            )
            
            # Send initial AI message
            initial_message = ConversationService._create_initial_message(section)
            message = Message.objects.create(
                conversation=conversation,
                content=initial_message,
                message_type=Message.MESSAGE_TYPE_AI
            )
            
            return ConversationStartResult(
                conversation_id=conversation.id,
                initial_message_id=message.id,
                section_id=section.id
            )
        except Exception as e:
            return ConversationStartResult(
                conversation_id=None,  # type: ignore
                initial_message_id=None,  # type: ignore
                section_id=section.id,
                success=False,
                error=str(e)
            )
    
    @staticmethod
    def send_message(conversation: Conversation, content: str, message_type: str = 'student') -> MessageSendResult:
        """Send a user message and get AI response."""
        try:
            # Save user message
            user_message = Message.objects.create(
                conversation=conversation,
                content=content,
                message_type=message_type
            )
            
            # Get AI response
            ai_response = LLMService.get_response(conversation, content, message_type)
            
            # Save AI response
            ai_message = Message.objects.create(
                conversation=conversation,
                content=ai_response,
                message_type=Message.MESSAGE_TYPE_AI
            )
            
            return MessageSendResult(
                user_message_id=user_message.id,
                ai_message_id=ai_message.id,
                ai_response=ai_response
            )
        except Exception as e:
            return MessageSendResult(
                success=False,
                error=str(e)
            )
    
    @staticmethod
    def get_conversation_data(conversation_id: UUID) -> Optional[ConversationData]:
        """Get conversation data including messages."""
        try:
            conversation = Conversation.objects.get(id=conversation_id)
            messages = conversation.messages.all().order_by('timestamp')
            
            message_data_list = [
                MessageData(
                    id=msg.id,
                    content=msg.content,
                    message_type=msg.message_type,
                    timestamp=msg.timestamp,
                    is_from_student=msg.is_from_student,
                    is_from_ai=msg.is_from_ai,
                    is_system_message=msg.is_system_message
                ) for msg in messages
            ]
            
            return ConversationData(
                id=conversation.id,
                user_id=conversation.user.id,
                section_id=conversation.section.id,
                section_title=conversation.section.title,
                created_at=conversation.created_at,
                updated_at=conversation.updated_at,
                is_teacher_test=conversation.is_teacher_test,
                is_student_conversation=conversation.is_student_conversation,
                messages=message_data_list
            )
        except Conversation.DoesNotExist:
            return None
        except Exception:
            return None
    
    @staticmethod
    def add_system_message(conversation: Conversation, content: str) -> Optional[UUID]:
        """Add a system message to the conversation."""
        try:
            message = Message.objects.create(
                conversation=conversation,
                content=content,
                message_type=Message.MESSAGE_TYPE_SYSTEM
            )
            return message.id
        except Exception:
            return None
    
    @staticmethod
    def delete_teacher_test_conversation(conversation: Conversation) -> bool:
        """Delete a teacher test conversation."""
        try:
            if not conversation.is_teacher_test:
                raise ValueError("Can only delete teacher test conversations.")
            
            conversation.soft_delete()
            return True
        except Exception:
            return False
    
    @staticmethod
    def get_teacher_test_conversations(teacher: 'Teacher', section: Optional[Section] = None) -> List[ConversationData]:
        """Get teacher test conversations for a teacher."""
        try:
            queryset = teacher.user.conversations.filter(
                is_deleted=False
            )
            
            if section:
                queryset = queryset.filter(section=section)
            
            conversations = queryset.order_by('-created_at')
            
            return [
                ConversationData(
                    id=conv.id,
                    user_id=conv.user.id,
                    section_id=conv.section.id,
                    section_title=conv.section.title,
                    created_at=conv.created_at,
                    updated_at=conv.updated_at,
                    is_teacher_test=conv.is_teacher_test,
                    is_student_conversation=conv.is_student_conversation
                ) for conv in conversations
            ]
        except Exception:
            return []
    
    @staticmethod
    def handle_r_code_execution(conversation: Conversation, code: str, output: str, error: Optional[str] = None) -> CodeExecutionResult:
        """Handle R code execution and add results to conversation."""
        try:
            # Add the R code as a student message
            code_message = Message.objects.create(
                conversation=conversation,
                content=code,
                message_type=Message.MESSAGE_TYPE_R_CODE
            )
            
            # Add the execution result
            if error:
                result_content = f"Error: {error}"
                result_type = Message.MESSAGE_TYPE_SYSTEM
                has_error = True
            else:
                result_content = f"Output:\n{output}"
                result_type = Message.MESSAGE_TYPE_CODE_EXECUTION
                has_error = False
            
            result_message = Message.objects.create(
                conversation=conversation,
                content=result_content,
                message_type=result_type
            )
            
            return CodeExecutionResult(
                code_message_id=code_message.id,
                result_message_id=result_message.id,
                has_error=has_error
            )
        except Exception as e:
            return CodeExecutionResult(
                success=False,
                error=str(e)
            )
    
    @staticmethod
    def _create_initial_message(section: Section) -> str:
        """Create initial AI message for a section."""
        return f"Hello! I'm here to help you with Section {section.order}: {section.title}. What would you like to work on?"
```

### 3. Submission Service

```python
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from datetime import datetime
from uuid import UUID
from django.db import transaction
from django.utils import timezone
from django.contrib.auth import get_user_model
from conversations.models import Submission, Conversation
from homeworks.models import Section
from accounts.models import Student

User = get_user_model()

@dataclass
class SubmissionResult:
    submission_id: Optional[UUID] = None
    conversation_id: Optional[UUID] = None
    section_id: Optional[UUID] = None
    is_new: bool = True
    success: bool = True
    error: Optional[str] = None

@dataclass
class SubmissionData:
    id: UUID
    conversation_id: UUID
    section_id: UUID
    section_title: str
    student_id: UUID
    student_name: str
    submitted_at: datetime

@dataclass
class AutoSubmitResult:
    total_sections: int
    processed_sections: int
    created_submissions: int
    error_count: int
    details: List[Dict[str, Any]]

class SubmissionService:
    """Service class for submission-related business logic."""
    
    @staticmethod
    def submit_section(user: User, conversation: Conversation) -> SubmissionResult:
        """Submit a section with the selected conversation."""
        try:
            with transaction.atomic():
                # Check if submission already exists for this user and section
                existing_submission = Submission.objects.filter(
                    conversation__user=user,
                    conversation__section=conversation.section
                ).first()
                
                if existing_submission:
                    # Update existing submission with new conversation
                    existing_submission.conversation = conversation
                    existing_submission.save()
                    return SubmissionResult(
                        submission_id=existing_submission.id,
                        conversation_id=conversation.id,
                        section_id=conversation.section.id,
                        is_new=False
                    )
                else:
                    # Create new submission
                    submission = Submission.objects.create(
                        conversation=conversation
                    )
                    return SubmissionResult(
                        submission_id=submission.id,
                        conversation_id=conversation.id,
                        section_id=conversation.section.id,
                        is_new=True
                    )
        except Exception as e:
            return SubmissionResult(
                success=False,
                error=str(e)
            )
    
    @staticmethod
    def get_submission_data(submission_id: UUID) -> Optional[SubmissionData]:
        """Get detailed submission data."""
        try:
            submission = Submission.objects.get(id=submission_id)
            return SubmissionData(
                id=submission.id,
                conversation_id=submission.conversation.id,
                section_id=submission.conversation.section.id,
                section_title=submission.conversation.section.title,
                student_id=submission.conversation.user.student_profile.id,
                student_name=f"{submission.conversation.user.first_name} {submission.conversation.user.last_name}",
                submitted_at=submission.submitted_at
            )
        except Submission.DoesNotExist:
            return None
        except Exception:
            return None
    
    @staticmethod
    def auto_submit_overdue_sections() -> AutoSubmitResult:
        """Automatically submit overdue sections for all students."""
        results = {
            'total_sections': 0,
            'processed_sections': 0,
            'created_submissions': 0,
            'error_count': 0,
            'details': []
        }
        
        try:
            # Get all overdue sections
            overdue_sections = Section.objects.filter(
                homework__due_date__lt=timezone.now()
            ).select_related('homework')
            
            results['total_sections'] = overdue_sections.count()
            
            for section in overdue_sections:
                results['processed_sections'] += 1
                section_result = {
                    'section_id': str(section.id),
                    'homework_id': str(section.homework.id),
                    'students_processed': 0,
                    'submissions_created': 0,
                    'errors': 0
                }
                
                # Find students without submissions for this section
                students_without_submissions = Student.objects.filter(
                    user__in=section.homework.students
                ).exclude(
                    user__conversations__submission__conversation__section=section
                )
                
                for student in students_without_submissions:
                    section_result['students_processed'] += 1
                    # Find their most recent conversation for this section
                    try:
                        conversation = section.conversations.filter(
                            user=student.user
                        ).latest('created_at')
                        
                        # Auto-submit
                        submission_result = SubmissionService.submit_section(student.user, conversation)
                        if submission_result.success:
                            results['created_submissions'] += 1
                            section_result['submissions_created'] += 1
                        else:
                            results['error_count'] += 1
                            section_result['errors'] += 1
                            
                    except Conversation.DoesNotExist:
                        # No conversation exists, skip
                        pass
                    except Exception:
                        results['error_count'] += 1
                        section_result['errors'] += 1
                
                results['details'].append(section_result)
                
            return AutoSubmitResult(
                total_sections=results['total_sections'],
                processed_sections=results['processed_sections'],
                created_submissions=results['created_submissions'],
                error_count=results['error_count'],
                details=results['details']
            )
        except Exception as e:
            return AutoSubmitResult(
                total_sections=0,
                processed_sections=0,
                created_submissions=0,
                error_count=1,
                details=[{'error': str(e)}]
            )
```

## Permission System

### 1. Permission Decorators

```python
from functools import wraps
from django.http import HttpResponseForbidden
from django.shortcuts import get_object_or_404
from accounts.models import get_teacher_or_student

def teacher_required(view_func):
    """Decorator to ensure user is a teacher."""
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        teacher, student = get_teacher_or_student(request.user)
        if not teacher:
            return HttpResponseForbidden("Teacher access required.")
        return view_func(request, *args, **kwargs)
    return wrapper

def student_required(view_func):
    """Decorator to ensure user is a student."""
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        teacher, student = get_teacher_or_student(request.user)
        if not student:
            return HttpResponseForbidden("Student access required.")
        return view_func(request, *args, **kwargs)
    return wrapper

def homework_owner_required(view_func):
    """Decorator to ensure teacher owns the homework."""
    @wraps(view_func)
    def wrapper(request, homework_id, *args, **kwargs):
        from homeworks.models import Homework
        homework = get_object_or_404(Homework, id=homework_id)
        teacher, student = get_teacher_or_student(request.user)
        
        if not teacher or homework.created_by != teacher:
            return HttpResponseForbidden("Access denied.")
        
        return view_func(request, homework, *args, **kwargs)
    return wrapper

def section_access_required(view_func):
    """Decorator to ensure user has access to section."""
    @wraps(view_func)
    def wrapper(request, section_id, *args, **kwargs):
        from homeworks.models import Section
        section = get_object_or_404(Section, id=section_id)
        teacher, student = get_teacher_or_student(request.user)
        
        if teacher and section.homework.created_by == teacher:
            # Teacher owns the homework
            return view_func(request, section, *args, **kwargs)
        elif student:
            # Student access
            return view_func(request, section, *args, **kwargs)
        else:
            return HttpResponseForbidden("Access denied.")
    return wrapper
```

## API Design

### 1. RESTful Endpoints

```python
# Main URLs
urlpatterns = [
    path('', views.home_view, name='home'),
    path('admin/', admin.site.urls),
    path('api/', include('api.urls')),
]

# API URLs
urlpatterns = [
    # Homework management
    path('homeworks/', views.HomeworkListView.as_view(), name='homework-list'),
    path('homeworks/create/', views.HomeworkCreateView.as_view(), name='homework-create'),
    path('homeworks/<uuid:homework_id>/', views.HomeworkDetailView.as_view(), name='homework-detail'),
    path('homeworks/<uuid:homework_id>/edit/', views.HomeworkEditView.as_view(), name='homework-edit'),
    path('homeworks/<uuid:homework_id>/delete/', views.HomeworkDeleteView.as_view(), name='homework-delete'),
    
    # Section management
    path('homeworks/<uuid:homework_id>/sections/', views.SectionListView.as_view(), name='section-list'),
    path('homeworks/<uuid:homework_id>/sections/create/', views.SectionCreateView.as_view(), name='section-create'),
    path('sections/<uuid:section_id>/', views.SectionDetailView.as_view(), name='section-detail'),
    path('sections/<uuid:section_id>/edit/', views.SectionEditView.as_view(), name='section-edit'),
    path('sections/<uuid:section_id>/delete/', views.SectionDeleteView.as_view(), name='section-delete'),
    
    # Conversation management
    path('sections/<uuid:section_id>/conversations/', views.ConversationListView.as_view(), name='conversation-list'),
    path('sections/<uuid:section_id>/conversations/start/', views.ConversationStartView.as_view(), name='conversation-start'),
    path('conversations/<uuid:conversation_id>/', views.ConversationDetailView.as_view(), name='conversation-detail'),
    path('conversations/<uuid:conversation_id>/send/', views.MessageSendView.as_view(), name='message-send'),
    path('conversations/<uuid:conversation_id>/delete/', views.ConversationDeleteView.as_view(), name='conversation-delete'),
    
    # Teacher testing
    path('sections/<uuid:section_id>/test/', views.TeacherTestStartView.as_view(), name='teacher-test-start'),
    path('test-conversations/<uuid:conversation_id>/', views.TeacherTestConversationView.as_view(), name='teacher-test-conversation'),
    path('test-conversations/<uuid:conversation_id>/delete/', views.TeacherTestDeleteView.as_view(), name='teacher-test-delete'),
    
    # Submission management (now in conversations app)
    path('sections/<uuid:section_id>/submit/', views.SectionSubmitView.as_view(), name='section-submit'),
    path('submissions/<uuid:submission_id>/', views.SubmissionDetailView.as_view(), name='submission-detail'),
]
```

### 2. View Classes

```python
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from uuid import UUID
from django.views import View
from django.shortcuts import render
from django.contrib.auth.decorators import login_required
from django.utils.decorators import method_decorator
from django.http import HttpRequest, HttpResponse
from permissions.decorators import teacher_required, student_required
from accounts.models import get_teacher_or_student
from homeworks.models import Homework
from homeworks.services import HomeworkService

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

@method_decorator(login_required, name='dispatch')
class HomeworkListView(View):
    """Display homeworks based on user role using testable-first approach."""
    
    def get(self, request: HttpRequest) -> HttpResponse:
        # Get typed data
        data = self._get_homework_list_data(request.user)
        
        # Single render call with data
        return render(request, 'homeworks/homework_list.html', {
            'data': data
        })
    
    def _get_homework_list_data(self, user) -> HomeworkListData:
        """Get typed data for homework list. Easy to test!"""
        teacher, student = get_teacher_or_student(user)
        has_progress_data = False
        
        if teacher:
            homeworks = Homework.objects.filter(created_by=teacher).order_by('-created_at')
            user_type = 'teacher'
        elif student:
            homeworks = Homework.objects.filter(sections__isnull=False).distinct().order_by('-created_at')
            user_type = 'student'
            has_progress_data = True
        else:
            homeworks = Homework.objects.none()
            user_type = 'unknown'
        
        # Build typed data
        homework_items = []
        for homework in homeworks:
            progress = None
            
            if student:
                # Get progress data for student
                progress_data = HomeworkService.get_student_homework_progress(student, homework)
                # Convert to list of dicts for template rendering
                progress = [
                    {
                        'section_id': str(p.section_id),
                        'title': p.title,
                        'order': p.order,
                        'status': p.status,
                        'conversation_id': str(p.conversation_id) if p.conversation_id else None
                    } for p in progress_data.sections_progress
                ]
            
            homework_item = HomeworkListItem(
                id=homework.id,
                title=homework.title,
                description=homework.description,
                due_date=homework.due_date,
                section_count=homework.section_count,
                created_at=homework.created_at,
                is_overdue=homework.is_overdue,
                progress=progress
            )
            homework_items.append(homework_item)
        
        return HomeworkListData(
            homeworks=homework_items,
            user_type=user_type,
            total_count=len(homework_items),
            has_progress_data=has_progress_data
        )

@dataclass
class SectionSubmitData:
    section_id: UUID
    section_title: str
    conversation_id: Optional[UUID] = None
    error: Optional[str] = None

@dataclass
class SectionSubmitResult:
    success: bool
    submission_id: Optional[UUID] = None
    section_id: Optional[UUID] = None
    section_title: Optional[str] = None
    error_message: Optional[str] = None

@method_decorator(login_required, name='dispatch')
class SectionSubmitView(View):
    """Submit a section with the selected conversation using testable-first approach."""
    
    @method_decorator(student_required)
    def post(self, request: HttpRequest, section_id: str) -> HttpResponse:
        # Convert input data to typed object
        input_data = self._get_submit_data(request, section_id)
        
        # Process the submission
        result = self._process_submission(request.user, input_data)
        
        # Handle result
        if result.success:
            messages.success(request, f"Section '{result.section_title}' submitted successfully!")
        else:
            messages.error(request, result.error_message or "Failed to submit section.")
            
        return redirect('section-detail', section_id=section_id)
    
    def _get_submit_data(self, request: HttpRequest, section_id: str) -> SectionSubmitData:
        """Parse and validate input data. Easy to test!"""
        try:
            section = get_object_or_404(Section, id=section_id)
            conversation_id = request.POST.get('conversation_id')
            
            if not conversation_id:
                return SectionSubmitData(
                    section_id=section.id,
                    section_title=section.title,
                    error="No conversation selected."
                )
                
            return SectionSubmitData(
                section_id=section.id,
                section_title=section.title,
                conversation_id=UUID(conversation_id)
            )
        except Exception as e:
            return SectionSubmitData(
                section_id=UUID(section_id) if section_id else None,  # type: ignore
                section_title="",
                error=str(e)
            )
    
    def _process_submission(self, user: User, data: SectionSubmitData) -> SectionSubmitResult:
        """Process the submission with error handling. Easy to test!"""
        if data.error:
            return SectionSubmitResult(
                success=False,
                section_id=data.section_id,
                section_title=data.section_title,
                error_message=data.error
            )
            
        try:
            # Get conversation
            conversation = Conversation.objects.get(
                id=data.conversation_id,
                user=user,
                section_id=data.section_id
            )
            
            # Submit section
            result = SubmissionService.submit_section(user, conversation)
            
            if result.success:
                return SectionSubmitResult(
                    success=True,
                    submission_id=result.submission_id,
                    section_id=data.section_id,
                    section_title=data.section_title
                )
            else:
                return SectionSubmitResult(
                    success=False,
                    section_id=data.section_id,
                    section_title=data.section_title,
                    error_message=result.error or "Failed to create submission."
                )
                
        except Conversation.DoesNotExist:
            return SectionSubmitResult(
                success=False,
                section_id=data.section_id,
                section_title=data.section_title,
                error_message="Invalid conversation selected."
            )
        except Exception as e:
            return SectionSubmitResult(
                success=False,
                section_id=data.section_id,
                section_title=data.section_title,
                error_message=str(e)
            )

@dataclass
class TeacherTestStartData:
    section_id: UUID
    section_title: str
    user_id: UUID

@dataclass
class TeacherTestStartResult:
    success: bool
    conversation_id: Optional[UUID] = None
    section_title: Optional[str] = None
    error_message: Optional[str] = None
    section_id: Optional[UUID] = None

@method_decorator(login_required, name='dispatch')
class TeacherTestStartView(View):
    """Start a teacher test conversation for a section using testable-first approach."""
    
    @method_decorator(teacher_required)
    @method_decorator(section_access_required)
    def post(self, request: HttpRequest, section: Section) -> HttpResponse:
        # Convert input to typed data
        input_data = TeacherTestStartData(
            section_id=section.id,
            section_title=section.title,
            user_id=request.user.id
        )
        
        # Process the request
        result = self._start_test_conversation(request.user, input_data)
        
        # Handle result
        if result.success:
            messages.success(request, f"Test conversation started for '{result.section_title}'")
            return redirect('teacher-test-conversation', conversation_id=result.conversation_id)
        else:
            messages.error(request, result.error_message or "Failed to start test conversation")
            return redirect('section-detail', section_id=result.section_id)
    
    def _start_test_conversation(self, user: User, data: TeacherTestStartData) -> TeacherTestStartResult:
        """Start a test conversation with error handling. Easy to test!"""
        try:
            section = Section.objects.get(id=data.section_id)
            result = ConversationService.start_conversation(user, section)
            
            if result.success:
                return TeacherTestStartResult(
                    success=True,
                    conversation_id=result.conversation_id,
                    section_title=data.section_title,
                    section_id=data.section_id
                )
            else:
                return TeacherTestStartResult(
                    success=False,
                    section_id=data.section_id,
                    section_title=data.section_title,
                    error_message=result.error
                )
        except Exception as e:
            return TeacherTestStartResult(
                success=False,
                section_id=data.section_id,
                section_title=data.section_title,
                error_message=f"Failed to start test conversation: {str(e)}"
            )

@dataclass
class TeacherTestConversationData:
    conversation_id: UUID
    section_id: UUID
    homework_id: UUID
    section_title: str
    homework_title: str
    messages: List[MessageData]
    is_teacher_test: bool

@dataclass
class TeacherTestMessageData:
    conversation_id: UUID
    content: str
    message_type: str = 'student'

@method_decorator(login_required, name='dispatch')
class TeacherTestConversationView(View):
    """View and interact with a teacher test conversation using testable-first approach."""
    
    @method_decorator(teacher_required)
    def get(self, request: HttpRequest, conversation_id: str) -> HttpResponse:
        # Get conversation data
        conversation_data = self._get_conversation_data(request.user, conversation_id)
        
        # Check access permissions
        if not conversation_data or not conversation_data.is_teacher_test:
            return HttpResponseForbidden("Access denied.")
        
        # Render with typed data
        return render(request, 'conversations/teacher_test_conversation.html', {
            'data': conversation_data
        })
    
    @method_decorator(teacher_required)
    def post(self, request: HttpRequest, conversation_id: str) -> HttpResponse:
        # Parse input data
        message_data = self._parse_message_data(request, conversation_id)
        
        # Validate access
        conversation_data = self._get_conversation_data(request.user, conversation_id)
        if not conversation_data or not conversation_data.is_teacher_test:
            return HttpResponseForbidden("Access denied.")
        
        # Validate content
        if not message_data.content:
            messages.error(request, "Message content is required.")
            return redirect('teacher-test-conversation', conversation_id=conversation_id)
        
        # Process message
        result = self._send_test_message(message_data)
        
        # Handle result
        if result.success:
            messages.success(request, "Message sent successfully!")
        else:
            messages.error(request, result.error or "Failed to send message.")
        
        return redirect('teacher-test-conversation', conversation_id=conversation_id)
    
    def _get_conversation_data(self, user: User, conversation_id: str) -> Optional[TeacherTestConversationData]:
        """Get conversation data with access control. Easy to test!"""
        try:
            # Get raw conversation
            conversation = Conversation.objects.get(id=conversation_id)
            
            # Check ownership
            if not conversation.is_teacher_test or conversation.user != user:
                return None
                
            # Get conversation data from service
            conversation_data = ConversationService.get_conversation_data(conversation.id)
            
            if not conversation_data:
                return None
                
            # Transform to view-specific data
            return TeacherTestConversationData(
                conversation_id=conversation_data.id,
                section_id=conversation_data.section_id,
                homework_id=conversation.section.homework.id,
                section_title=conversation_data.section_title,
                homework_title=conversation.section.homework.title,
                messages=conversation_data.messages or [],
                is_teacher_test=conversation_data.is_teacher_test
            )
        except Conversation.DoesNotExist:
            return None
        except Exception:
            return None
    
    def _parse_message_data(self, request: HttpRequest, conversation_id: str) -> TeacherTestMessageData:
        """Parse message data from request. Easy to test!"""
        content = request.POST.get('content', '')
        return TeacherTestMessageData(
            conversation_id=UUID(conversation_id),
            content=content
        )
    
    def _send_test_message(self, data: TeacherTestMessageData) -> MessageSendResult:
        """Send a test message. Easy to test!"""
        try:
            # Get conversation
            conversation = Conversation.objects.get(id=data.conversation_id)
            
            # Send message using service
            return ConversationService.send_message(
                conversation=conversation,
                content=data.content,
                message_type=data.message_type
            )
        except Conversation.DoesNotExist:
            return MessageSendResult(
                success=False,
                error="Conversation not found."
            )
        except Exception as e:
            return MessageSendResult(
                success=False,
                error=f"Failed to send message: {str(e)}"
            )

class TeacherTestDeleteView(LoginRequiredMixin, View):
    """Delete a teacher test conversation."""
    
    @teacher_required
    def post(self, request, conversation_id):
        conversation = get_object_or_404(Conversation, id=conversation_id)
        
        # Ensure teacher owns this test conversation
        if not conversation.is_teacher_test or conversation.user != request.user:
            return HttpResponseForbidden("Access denied.")
        
        try:
            ConversationService.delete_teacher_test_conversation(conversation)
            messages.success(request, "Test conversation deleted successfully!")
            return redirect('section-detail', section_id=conversation.section.id)
        except Exception as e:
            messages.error(request, f"Failed to delete test conversation: {e}")
            return redirect('teacher-test-conversation', conversation_id=conversation.id)
```

## Database Migrations

### 1. Initial Migration

```python
# 0001_initial.py
from django.db import migrations, models
import uuid

class Migration(migrations.Migration):
    initial = True
    
    dependencies = []
    
    operations = [
        migrations.CreateModel(
            name='User',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ('password', models.CharField(max_length=128, verbose_name='password')),
                ('last_login', models.DateTimeField(blank=True, null=True, verbose_name='last login')),
                ('is_superuser', models.BooleanField(default=False, help_text='Designates that this user has all permissions without explicitly assigning them.', verbose_name='superuser status')),
                ('username', models.CharField(max_length=150, unique=True)),
                ('first_name', models.CharField(blank=True, max_length=150)),
                ('last_name', models.CharField(blank=True, max_length=150)),
                ('email', models.EmailField(blank=True, max_length=254)),
                ('is_staff', models.BooleanField(default=False)),
                ('is_active', models.BooleanField(default=True)),
                ('date_joined', models.DateTimeField(auto_now_add=True)),
                ('groups', models.ManyToManyField(blank=True, help_text='The groups this user belongs to.', related_name='user_set', related_query_name='user', to='auth.group', verbose_name='groups')),
                ('user_permissions', models.ManyToManyField(blank=True, help_text='Specific permissions for this user.', related_name='user_set', related_query_name='user', to='auth.permission', verbose_name='user permissions')),
            ],
            options={
                'abstract': False,
            },
        ),
        # ... other models
    ]
```

## Testing Strategy

### 1. Test Structure

```python
# tests/test_services.py
from django.test import TestCase
from django.contrib.auth import get_user_model
from django.utils import timezone
from datetime import timedelta
from unittest.mock import patch, MagicMock
from homeworks.services import HomeworkService
from homeworks.models import Homework, Section, SectionSolution, Teacher
from homeworks.services import HomeworkCreateData, SectionCreateData, HomeworkCreateResult

class HomeworkServiceTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='testteacher',
            password='testpass123'
        )
        self.teacher = Teacher.objects.create(user=self.user)
        
        # Create typed input data
        self.section1 = SectionCreateData(
            title='Section 1',
            content='Test content 1',
            order=1,
            solution='Test solution 1'
        )
        
        self.section2 = SectionCreateData(
            title='Section 2',
            content='Test content 2',
            order=2,
            solution='Test solution 2'
        )
        
        self.homework_data = HomeworkCreateData(
            title='Test Homework',
            description='Test Description',
            due_date=timezone.now() + timedelta(days=7),
            sections=[self.section1, self.section2]
        )
    
    def test_create_homework_with_sections(self):
        """Test creating homework with multiple sections using typed data."""
        # Execute the service method
        result = HomeworkService.create_homework_with_sections(
            self.homework_data, 
            self.teacher
        )
        
        # Check result type and success
        self.assertIsInstance(result, HomeworkCreateResult)
        self.assertTrue(result.success)
        self.assertIsNotNone(result.homework_id)
        self.assertEqual(len(result.section_ids), 2)
        
        # Verify created objects
        homework = Homework.objects.get(id=result.homework_id)
        self.assertEqual(homework.title, self.homework_data.title)
        
        sections = Section.objects.filter(homework=homework).order_by('order')
        self.assertEqual(sections.count(), 2)
        self.assertEqual(sections[0].order, 1)
        self.assertEqual(sections[1].order, 2)
        self.assertIsNotNone(sections[0].solution)
        self.assertIsNotNone(sections[1].solution)

# tests/test_views.py
from django.test import TestCase, RequestFactory
from django.contrib.auth import get_user_model
from homeworks.views import HomeworkListView
from homeworks.models import Homework
from homeworks.services import HomeworkProgressData, SectionProgressData

class HomeworkListViewTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.user = get_user_model().objects.create_user(
            username='testuser',
            password='testpass123'
        )
    
    def test_get_homework_list_data(self):
        """Test the data generation method independently."""
        # Create a view instance
        view = HomeworkListView()
        
        # Execute the data generation method directly
        data = view._get_homework_list_data(self.user)
        
        # Verify the structure and content of data
        self.assertIsNotNone(data)
        self.assertEqual(data.user_type, 'unknown')
        self.assertEqual(data.total_count, 0)
        self.assertEqual(len(data.homeworks), 0)
    
    @patch('homeworks.services.HomeworkService.get_student_homework_progress')
    def test_student_homework_progress(self, mock_get_progress):
        """Test student homework progress data."""
        # Setup mock
        mock_section_progress = [
            SectionProgressData(
                section_id=MagicMock(),
                title="Test Section",
                order=1,
                status="not_started"
            )
        ]
        
        mock_progress_data = HomeworkProgressData(
            homework_id=MagicMock(),
            sections_progress=mock_section_progress
        )
        
        mock_get_progress.return_value = mock_progress_data
        
        # Create view with student user
        view = HomeworkListView()
        
        # Call method under test with mocked dependencies
        # This is the power of testable-first approach - we can test data logic
        # without needing HTTP requests or templates
        data = view._get_homework_list_data(self.user)
        
        # Assert on the result
        self.assertIsNotNone(data)
```

## Deployment Configuration

### 1. Production Settings

```python
# llteacher/production.py
from .settings import *

DEBUG = False
ALLOWED_HOSTS = ['yourdomain.com', 'www.yourdomain.com']

# Security settings
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True

# Database (SQLite for production as specified)
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
    }
}

# Static files
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_STORAGE = 'django.contrib.staticfiles.storage.StaticFilesStorage'

# Logging
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'file': {
            'level': 'INFO',
            'class': 'logging.FileHandler',
            'filename': BASE_DIR / 'logs' / 'django.log',
        },
    },
    'loggers': {
        'django': {
            'handlers': ['file'],
            'level': 'INFO',
            'propagate': True,
        },
    },
}
```

## Performance Considerations

### 1. Database Optimization

```python
# Optimized queries with select_related and prefetch_related
class HomeworkService:
    @staticmethod
    def get_teacher_homework_with_stats(teacher):
        """Get homework with optimized queries for statistics."""
        return Homework.objects.filter(created_by=teacher).select_related(
            'llm_config'
        ).prefetch_related(
            'sections__submissions__student__user',
            'sections__conversations__messages'
        ).annotate(
            section_count=Count('sections'),
            submission_count=Count('sections__submissions'),
            active_conversation_count=Count('sections__conversations')
        )
```

### 2. Caching Strategy

```python
from django.core.cache import cache
from django.conf import settings

class CacheService:
    """Service for managing application caching."""
    
    @staticmethod
    def get_homework_progress(student_id, homework_id):
        """Get cached homework progress for a student."""
        cache_key = f"homework_progress:{student_id}:{homework_id}"
        progress = cache.get(cache_key)
        
        if progress is None:
            # Calculate progress and cache for 5 minutes
            progress = SubmissionService.get_student_homework_progress(student_id, homework_id)
            cache.set(cache_key, progress, 300)
        
        return progress
```

## Security Considerations

### 1. Input Validation

```python
from django.core.validators import validate_slug
from django.core.exceptions import ValidationError

class Section(models.Model):
    # ... existing fields ...
    
    def clean(self):
        """Validate section data."""
        super().clean()
        
        # Ensure order is within homework's section limit
        if self.homework and self.order > 20:
            raise ValidationError("Maximum 20 sections allowed per homework.")
        
        # Ensure order is unique within homework
        if self.homework:
            existing_sections = Section.objects.filter(
                homework=self.homework,
                order=self.order
            ).exclude(id=self.id)
            
            if existing_sections.exists():
                raise ValidationError(f"Section with order {self.order} already exists.")
```

### 2. Permission Enforcement

```python
class SectionAccessMixin:
    """Mixin to ensure proper access to sections."""
    
    def dispatch(self, request, *args, **kwargs):
        section = self.get_object()
        teacher, student = get_teacher_or_student(request.user)
        
        if teacher and section.homework.created_by == teacher:
            return super().dispatch(request, *args, **kwargs)
        elif student:
            return super().dispatch(request, *args, **kwargs)
        else:
            return HttpResponseForbidden("Access denied.")
```

## Template Usage with Typed Data

One of the key advantages of the testable-first architecture is how it simplifies templates. By receiving well-defined typed data structures, templates become cleaner and more predictable.

### Example Template with Typed Data

```html
<!-- Template receives typed data -->
{% for homework in data.homeworks %}
    <div class="homework-item">
        <h3>{{ homework.title }}</h3>
        <p>{{ homework.description }}</p>
        <p>Due: {{ homework.due_date }}</p>
        <p>Sections: {{ homework.section_count }}</p>
        
        {% if homework.progress %}
            <div class="progress">
                {% for section in homework.progress %}
                    <span class="status-{{ section.status }}">
                        {{ section.title }}: {{ section.status }}
                    </span>
                {% endfor %}
            </div>
        {% endif %}
    </div>
{% endfor %}
```

### Benefits for Templates

1. **Predictable Structure**: Templates can rely on consistent, well-defined data structures
2. **Type Safety**: Data contracts ensure required fields are always available
3. **Cleaner Logic**: Templates focus on display, not data manipulation
4. **Easier Testing**: Template rendering can be tested with mock typed data
5. **Better Developer Experience**: Clear separation between data preparation and presentation

## Future Enhancements

### 1. Phase 2 Features
- **Real-time Updates**: WebSocket support for live conversation updates
- **Advanced Analytics**: Teacher dashboard with student progress metrics
- **Assignment Templates**: Pre-built homework templates for common subjects
- **Mobile App**: Native mobile applications for iOS and Android

### 2. Phase 3 Features
- **Multi-language Support**: Internationalization for global use
- **Advanced LLM Features**: Support for multiple AI models and providers
- **Integration APIs**: RESTful APIs for third-party integrations
- **Advanced Reporting**: Detailed analytics and export capabilities

## Key Benefits of the New Architecture

### 1. **Testable-First Approach**
- **Typed Data Contracts**: Clear dataclasses for all data passing between layers
- **Isolated Logic**: Service and view methods can be tested independently
- **Error Handling**: Comprehensive error handling with typed error responses
- **Predictable Interfaces**: Well-defined input and output contracts
- **Traceable Data Flow**: Clear paths for data through the system layers

### 2. **Cleaner Data Relationships**
- **No Nullable Foreign Keys**: Every relationship is clear and unambiguous
- **Hierarchical Structure**: Homework → Section → Conversation → Submission flow is intuitive
- **Eliminated Redundancy**: Removed unnecessary fields and complex soft delete logic
- **Unified User Model**: Single user field in conversations, type determined by user profile
- **No Circular Dependencies**: Clean separation between homework structure and conversation/submission data

### 3. **Teacher Testing Capabilities**
- **Test Conversations**: Teachers can create test conversations to verify AI tutor quality
- **Separate Tracking**: Test conversations are clearly distinguished from student conversations
- **Easy Cleanup**: Teachers can delete test conversations when no longer needed
- **Quality Assurance**: Ensures homework assignments provide good AI guidance before students use them

### 4. **Simplified Business Logic**
- **Clear Ownership**: Each conversation belongs to exactly one student and one section
- **Straightforward Submissions**: Submission simply tracks which conversation represents the final work
- **Easier Queries**: No need to check multiple fields or handle nullable relationships
- **Logical Grouping**: Submissions are naturally grouped with conversations since they represent conversation state
- **Pure Functions**: Service methods with clear inputs and outputs, minimal side effects

### 5. **Better Performance**
- **Optimized Queries**: Simpler relationships mean faster database operations
- **Reduced Complexity**: Fewer edge cases and validation rules to process
- **Cleaner Caching**: Simpler data structures are easier to cache effectively
- **Targeted Data Loading**: Load only the data needed for each view with typed data structures

### 6. **Improved Maintainability**
- **Less Code**: Fewer fields and methods to maintain
- **Clearer Intent**: Each model, service, and view has a single, well-defined purpose
- **Easier Testing**: Typed data contracts and pure functions are easier to test and debug
- **Better Separation of Concerns**: Clear boundaries between data, business logic, and presentation

## Conclusion

LLTeacher v2 addresses the critical architectural flaws of v1 while maintaining the innovative core concept. The new design provides:

1. **Testable-First Architecture**: Typed data contracts and pure methods for reliable testing
2. **Clean Data Model**: Simplified relationships with proper constraints
3. **Service Layer Architecture**: Business logic separated from presentation
4. **Improved Performance**: Optimized queries and caching strategy
5. **Better User Experience**: Streamlined workflows and progress tracking
6. **Maintainable Codebase**: Clear separation of concerns and comprehensive type safety

The system is designed to be testable, scalable, maintainable, and user-friendly while preserving the revolutionary AI-guided learning approach that makes LLTeacher unique.
